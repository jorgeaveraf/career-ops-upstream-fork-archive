import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { openCandidateKnowledge } from '../candidate-knowledge/provider.mjs';
import { DeepEvaluationEngine } from '../deep-evaluation/engine.mjs';
import { ApplicationPackageEngine } from '../application-package/engine.mjs';
import { GoogleSheetsApiAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { HumanControlPlaneSync } from '../human-control-plane/sync.mjs';
import { ELIGIBILITY_RULES_VERSION, RANKING_RULES_VERSION } from '../intelligence/contracts.mjs';
import { loadOpportunityPolicy } from '../intelligence/profile-policy.mjs';
import { assessOpportunity, assessmentInputHash } from '../intelligence/funnel.mjs';
import { CandidateSelectionEngine, buildDailyPrioritySnapshot } from '../candidate-selection/engine.mjs';
import { loadCandidateSelectionPolicy } from '../candidate-selection/policy.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from '../registry/job-registry.mjs';
import { runDaily } from '../runner/daily-runner.mjs';
import { ERROR_SEVERITIES, OPERATIONAL_EXIT_CODES, operationalError } from './contracts.mjs';
import { buildEmailMessage, notificationProviderFromEnv } from './notification-provider.mjs';
import { decideNotification } from './notification-rules.mjs';
import { buildOperationalSummary } from './summary.mjs';
import { createGoogleOAuthTokenProviderFromEnv } from '../operations/google-oauth.mjs';
import { EVIDENCE_COMPLETENESS_VERSION, RESEARCH_NEEDS_VERSION, UNIFIED_CANDIDATE_POLICY_VERSION } from '../intelligence/unified-candidate-policy.mjs';
import { matchPreferenceSignals } from '../human-decision/rejection-intelligence.mjs';
import { FeedbackCalibrationEngine } from '../feedback-calibration/engine.mjs';
import { reconcileSheetHumanInputs } from '../execution-orchestration/reconciler.mjs';

const timestamp = clock => clock().toISOString();

export async function rankOperationalCandidates({ registry, discoveryRunId, profilePath, portalsPath, clock, limit = 100 }) {
  const policy = loadOpportunityPolicy({ profilePath, portalsPath });
  const selectionPolicy = loadCandidateSelectionPolicy({
    profilePath, portalsPath, overrides: { maxActiveCandidates: limit },
  });
  const preferenceSignals = registry.listPreferenceSignals({ activeOnly: true });
  const calibration=new FeedbackCalibrationEngine({registry,clock});
  const candidates = registry.listCandidateSelectionInputs({ runId: discoveryRunId }).map(candidate => {const rejection=matchPreferenceSignals(candidate, preferenceSignals),learned=calibration.adjustmentFor(candidate);return{
    ...candidate,humanPreference:{adjustment:Math.max(-15,Math.min(6,Number(rejection.adjustment||0)+Number(learned.adjustment||0))),reasons:[...(rejection.reasons||[]),...(learned.reasons||[])],evidenceRefs:rejection.evidenceRefs||[],signalIds:[...(rejection.signalIds||[]),...(learned.signalIds||[])]},
  };});
  const selection = new CandidateSelectionEngine({ policy: selectionPolicy, clock }).select({
    candidates, previousCandidates: registry.listActiveCandidates(),
  });
  registry.recordCandidateSelection(discoveryRunId, selection, { decidedAt: timestamp(clock) });
  const byJob = new Map(candidates.map(item => [item.jobId, item]));
  const assessments = [];
  for (const selected of selection.activeCandidates) {
    const candidate = { ...byJob.get(selected.jobId), selectionScore: selected.preliminaryScore, selectionRank: selected.selectionRank };
    const latest = registry.getLatestAssessment(selected.jobId);
    if (latest && latest.observationId === selected.observationId
      && latest.eligibilityRulesVersion === ELIGIBILITY_RULES_VERSION
      && latest.rankingRulesVersion === RANKING_RULES_VERSION
      && latest.profileHash === policy.profileHash
      && latest.inputHash === assessmentInputHash(candidate)) {
      assessments.push({ ...latest, existing: true });
    } else {
      assessments.push(registry.recordAssessment(
        selected.jobId, selected.observationId,
        assessOpportunity(candidate, policy, { calculatedAt: timestamp(clock) }),
      ));
    }
    const assessment = assessments.at(-1);
    registry.syncCandidateResearchNeeds({
      selectionRunId: discoveryRunId, assessmentId: assessment.id, jobId: selected.jobId,
      observationId: selected.observationId, needs: assessment.result?.eligibility?.researchNeeds || [],
      versions: {
        unifiedPolicyVersion: UNIFIED_CANDIDATE_POLICY_VERSION,
        eligibilityRulesVersion: ELIGIBILITY_RULES_VERSION,
        completenessVersion: EVIDENCE_COMPLETENESS_VERSION,
        researchNeedsVersion: RESEARCH_NEEDS_VERSION,
      }, policyHash: policy.policyHash,
    });
  }
  const previousRanks = registry.getPreviousPriorityRanks(discoveryRunId, selection.activeCandidates.map(item => item.jobId));
  const snapshotDate = clock().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const snapshot = buildDailyPrioritySnapshot({
    runId: discoveryRunId, snapshotDate, activeCandidates: selection.activeCandidates,
    assessments, previousRanks, policy: selectionPolicy,
  });
  registry.recordDailyPrioritySnapshot(discoveryRunId, snapshot, { createdAt: timestamp(clock) });
  const created = assessments.filter(item => !item.existing);
  const topIds = new Set(snapshot.top10.map(item => item.jobId));
  registry.recordSemanticFunnelMetrics(discoveryRunId, {
    RAW_DISCOVERED: selection.counts.raw,
    NORMALIZED: selection.counts.raw,
    UNIQUE_JOBS: selection.counts.raw,
    FILTER_PASS: selection.counts.PASS,
    FILTER_REJECT: selection.counts.REJECT,
    FILTER_UNKNOWN: selection.counts.UNKNOWN,
    ACTIVE_SET: selection.counts.active,
    ELIGIBILITY_ELIGIBLE: assessments.filter(item => item.eligibilityStatus === 'ELIGIBLE').length,
    ELIGIBILITY_INELIGIBLE: assessments.filter(item => item.eligibilityStatus === 'INELIGIBLE').length,
    ELIGIBILITY_UNKNOWN: assessments.filter(item => item.eligibilityStatus === 'UNKNOWN').length,
    RANKED: snapshot.ranked, TOP_10: snapshot.top10.length,
    DEEP_EVALUATED: 0, PACKAGE_READY: 0,
  });
  return {
    processed: created.length,
    eligible: assessments.filter(item => item.eligibilityStatus === 'ELIGIBLE').length,
    shortlisted: snapshot.top10.length,
    shortlistedJobIds: snapshot.top10.map(item => item.jobId),
    activeSet: selection.counts.active,
    filter: { pass: selection.counts.PASS, reject: selection.counts.REJECT, unknown: selection.counts.UNKNOWN },
    snapshot: { date: snapshotDate, ranked: snapshot.ranked, top10: snapshot.top10.length },
    recommendations: snapshot.top10.map(item => {
      const candidate = byJob.get(item.jobId) || {};
      return {
        jobId: item.jobId, company: candidate.company || '', role: candidate.title || '',
        priority: item.finalPriorityScore, reasons: item.reasons || [],
        jobUrl: candidate.canonicalUrl || candidate.sourceUrl || '', packageReady: false,
        evidenceWeak: item.evidenceWeak, poolOnly: item.poolOnly,
      };
    }),
  };
}

export async function evaluateOperationalCandidates({ registry, jobIds, candidateProvider, clock }) {
  const engine = new DeepEvaluationEngine({ candidateProvider, clock });
  const stored = [];
  for (const jobId of jobIds) {
    const selected = registry.listDeepEvaluationCandidates({ jobId, limit: 1 })[0];
    if (!selected) continue;
    const artifact = await engine.evaluate({ ...selected, useLLM: false });
    stored.push(registry.recordJobEvaluation(artifact));
  }
  const created = stored.filter(item => !item.existing);
  return {
    completed: created.length,
    apply: created.filter(item => item.status === 'VALID' && item.recommendation === 'APPLY').length,
    evaluations: created,
  };
}

export async function packageOperationalCandidates({ registry, evaluations, candidateProvider, canonicalCv, clock }) {
  const engine = new ApplicationPackageEngine({ candidateProvider, clock });
  const stored = [];
  for (const evaluation of evaluations.filter(item => item.status === 'VALID' && item.recommendation === 'APPLY')) {
    const artifact = await engine.generate({ evaluationArtifact: evaluation, canonicalCv, useLLM: false });
    stored.push(registry.recordApplicationPackage(artifact));
  }
  const created = stored.filter(item => !item.existing && item.validationStatus === 'VALID');
  return { ready: created.length, packages: created };
}

export async function syncOperationalSheet({ registry, spreadsheetId, tokenProvider, adapter, projectRoot, clock, env = process.env }) {
  if (!spreadsheetId) { const error = new Error('CAREER_OPS_SHEET_ID is required'); error.code = 'SHEET_SYNC_UNAVAILABLE'; throw error; }
  const sheets = adapter || new GoogleSheetsApiAdapter({ spreadsheetId, tokenProvider: tokenProvider || createGoogleOAuthTokenProviderFromEnv({ env }) });
  await sheets.initialize();
  const result=await reconcileSheetHumanInputs({registry,adapter:sheets,spreadsheetId,user:'daily-auto',projectRoot,clock,project:true,preserveHumanEdits:true});
  return { synced: true, spreadsheetId, ...result };
}

export async function reconcileOperationalHumanInputs({registry,spreadsheetId,tokenProvider,adapter,projectRoot,clock,env=process.env}={}){
  if(!spreadsheetId)return{synced:false,skipped:true,reason:'SHEET_SYNC_UNAVAILABLE'};
  const sheets=adapter||new GoogleSheetsApiAdapter({spreadsheetId,tokenProvider:tokenProvider||createGoogleOAuthTokenProviderFromEnv({env})});
  await sheets.initialize();
  return reconcileSheetHumanInputs({registry,adapter:sheets,spreadsheetId,user:'daily-auto',projectRoot,clock,project:false});
}

export function buildOperationalDryRun({ dbPath = DEFAULT_REGISTRY_PATH, spreadsheetId = '' } = {}) {
  return {
    dryRun: true, status: 'SUCCESS', exitCode: 0,
    plan: [
      'would create one persisted operational run',
      'would invoke the existing Daily Runner for discovery',
      'would reconcile the bounded rolling candidate set from the complete Registry',
      'would deterministically evaluate new SHORTLIST candidates',
      'would generate review-only packages for new VALID APPLY evaluations',
      `would pull human inputs and push the projection${spreadsheetId ? ` to ${spreadsheetId}` : ''}`,
      'would send one email only if notification rules require it',
    ],
    targets: { dbPath, spreadsheetId: spreadsheetId || null },
    skipped: ['registry writes', 'discovery', 'Google Sheets API', 'email provider', 'applications and messages'],
  };
}

export async function runOperationalLoop({
  id = randomUUID(), dbPath = process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH,
  projectRoot = process.cwd(), profilePath = process.env.CAREER_OPS_PROFILE || 'config/profile.yml',
  portalsPath = process.env.CAREER_OPS_PORTALS || 'portals.yml',
  spreadsheetId = process.env.CAREER_OPS_SHEET_ID || '', tokenProvider = null,
  dashboardUrl = process.env.CAREER_OPS_DASHBOARD_URL || (spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : ''),
  env = process.env, clock = () => new Date(), registry: suppliedRegistry = null,
  dailyRunner = runDaily, rankStage = rankOperationalCandidates,
  evaluationStage = evaluateOperationalCandidates, packageStage = packageOperationalCandidates,
  sheetStage = syncOperationalSheet, notificationProvider,
  humanInputStage = null, sheetAdapter = null, canonicalCv,
} = {}) {
  const ownsRegistry = !suppliedRegistry;
  const registry = suppliedRegistry || openJobRegistry({ dbPath, clock });
  const startedAt = timestamp(clock);
  const started = registry.startOperationalRun({ id, startedAt });
  if (started.existing && started.status !== 'RUNNING') {
    return { status: started.status, exitCode: OPERATIONAL_EXIT_CODES[started.status], summary: started.summary, existing: true };
  }
  const errors = [];
  let discovery = { status: 'NOT_RUN' };
  let ranking = { processed: 0, eligible: 0, shortlisted: 0, shortlistedJobIds: [], recommendations: [] };
  let evaluations = { completed: 0, apply: 0, evaluations: [] };
  let packages = { ready: 0, packages: [] };
  let sheet = { synced: false, spreadsheetId };
  let delivery = { required: false, reasons: [], sent: false, status: 'NOT_REQUIRED' };
  try {
    const reconcileStage=humanInputStage||(sheetStage===syncOperationalSheet?reconcileOperationalHumanInputs:async()=>({skipped:true,reason:'INJECTED_SHEET_STAGE'}));
    await reconcileStage({registry,spreadsheetId,tokenProvider,adapter:sheetAdapter,projectRoot,clock,env});
  } catch(error) {
    errors.push(operationalError('human-input-reconciliation',error,{code:error.code||'SHEET_RECONCILIATION_UNAVAILABLE'}));
  }
  try {
    const daily = await dailyRunner({ dbPath, runId: `${id}:discovery`, clock });
    discovery = {
      status: daily.status, runId: daily.summary?.run?.id || null,
      observations: daily.summary?.discovery?.observations || 0,
      newJobs: daily.summary?.discovery?.newJobs || 0,
      changedJobs: daily.summary?.discovery?.changedJobs || 0,
    };
    if (daily.status === 'FAILED') errors.push(operationalError('discovery', new Error('Daily Runner failed'), { code: 'DAILY_RUN_FAILED' }));
    for (const failure of daily.summary?.failures || []) {
      errors.push(operationalError('discovery', new Error(failure.message), { severity: ERROR_SEVERITIES.INFO, code: failure.code }));
    }
  } catch (error) {
    errors.push(operationalError('discovery', error, { code: 'DAILY_RUN_FAILED' }));
    discovery.status = 'FAILED';
  }

  if (discovery.status !== 'FAILED' && discovery.runId) {
    try { ranking = await rankStage({ registry, discoveryRunId: discovery.runId, profilePath, portalsPath, clock }); }
    catch (error) { errors.push(operationalError('ranking', error)); }
    try {
      const candidateProvider = openCandidateKnowledge({ projectRoot });
      evaluations = await evaluationStage({ registry, jobIds: ranking.shortlistedJobIds, candidateProvider, clock });
      packages = await packageStage({
        registry, evaluations: evaluations.evaluations, candidateProvider,
        canonicalCv: canonicalCv ?? readFileSync(new URL('../cv.md', import.meta.url), 'utf8'), clock,
      });
      const readyIds = new Set(packages.packages.map(item => item.jobId));
      ranking.recommendations = ranking.recommendations.map(item => ({ ...item, packageReady: readyIds.has(item.jobId) }));
      if (registry.getRun(discovery.runId)) {
        registry.recordSemanticFunnelMetrics(discovery.runId, {
          DEEP_EVALUATED: evaluations.completed,
          PACKAGE_READY: packages.ready,
        });
      }
    } catch (error) {
      const stage = evaluations.completed ? 'packages' : 'evaluation';
      errors.push(operationalError(stage, error));
    }
  }

  try {
    sheet = await sheetStage({ registry, spreadsheetId, tokenProvider, adapter: sheetAdapter, projectRoot, clock, env });
  } catch (error) {
    errors.push(operationalError('sheet', error, { code: error.code || 'SHEET_SYNC_UNAVAILABLE' }));
  }

  let status = discovery.status === 'FAILED' ? 'FAILED'
    : discovery.status === 'PARTIAL' || errors.some(item => item.severity === ERROR_SEVERITIES.ATTENTION) ? 'PARTIAL' : 'SUCCESS';
  const finishedAt = timestamp(clock);
  let summary = buildOperationalSummary({ id, startedAt, finishedAt, status, discovery, ranking, evaluations, packages, sheet, errors, dashboardUrl, notification: delivery });
  const decision = decideNotification(summary);
  delivery = { ...delivery, ...decision, status: decision.required ? 'PENDING' : 'NOT_REQUIRED' };
  let provider = notificationProvider;
  if (decision.required && provider === undefined) {
    try { provider = notificationProviderFromEnv(env); }
    catch (error) { errors.push(operationalError('notification', error, { code: 'NOTIFICATION_CONFIG_INVALID' })); provider = null; status = status === 'FAILED' ? status : 'PARTIAL'; }
  }
  if (decision.required) {
    const existing = registry.getNotificationDelivery(id, 'email');
    if (existing) delivery = { ...delivery, sent: existing.status === 'SENT', status: existing.status, existing: true };
    else if (!provider) {
      delivery.status = 'DISABLED';
    } else {
      const message = buildEmailMessage(summary, { from: provider.from, to: provider.to });
      try {
        const sent = await provider.sendSummary({ ...message, idempotencyKey: `career-ops:${id}:email` });
        registry.recordNotificationDelivery({ operationalRunId: id, provider: provider.id, recipient: provider.to || message.to || 'configured-recipient', status: 'SENT', subject: message.subject, providerMessageId: sent.id, attemptedAt: timestamp(clock), sentAt: timestamp(clock) });
        delivery = { ...delivery, sent: true, status: 'SENT' };
      } catch (error) {
        errors.push(operationalError('notification', error, { code: error.code || 'EMAIL_SEND_FAILED' }));
        registry.recordNotificationDelivery({ operationalRunId: id, provider: provider.id, recipient: provider.to || message.to || 'configured-recipient', status: 'FAILED', subject: message.subject, error: error.message, attemptedAt: timestamp(clock) });
        delivery.status = 'FAILED'; status = status === 'FAILED' ? status : 'PARTIAL';
      }
    }
  }
  summary = buildOperationalSummary({ id, startedAt, finishedAt, status, discovery, ranking, evaluations, packages, sheet, errors, dashboardUrl, notification: delivery });
  const stored = registry.finishOperationalRun(id, {
    status, discoveryRunId: discovery.runId, finishedAt, summary, errors,
    jobsFound: discovery.newJobs, eligible: ranking.eligible, shortlisted: ranking.shortlisted,
    evaluationsCompleted: evaluations.completed, packagesReady: packages.ready,
    sheetSynced: sheet.synced, notificationRequired: delivery.required, notificationSent: delivery.sent,
  });
  if (ownsRegistry) registry.close();
  return { status, exitCode: OPERATIONAL_EXIT_CODES[status], summary: stored.summary };
}
