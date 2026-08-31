import { randomUUID } from 'crypto';
import { buildDailyPrioritySnapshot } from '../candidate-selection/engine.mjs';
import { loadCandidateSelectionPolicy } from '../candidate-selection/policy.mjs';
import { assessOpportunity } from '../intelligence/funnel.mjs';
import { loadOpportunityPolicy } from '../intelligence/profile-policy.mjs';
import { EVIDENCE_COMPLETENESS_VERSION, RESEARCH_NEEDS_VERSION, UNIFIED_CANDIDATE_POLICY_VERSION } from '../intelligence/unified-candidate-policy.mjs';
import { browserRunbookForTask } from './source-runbooks.mjs';
import { evidenceResolvesNeed, extractCandidateEvidence, validateCandidateIdentity } from './enrichment-evidence.mjs';
import { PriorityResearchPlanner } from './priority-research-planner.mjs';
import { selectPipelineAdmission } from '../intelligence/pipeline-admission.mjs';
import { isQualificationBlockingResearch } from '../intelligence/qualification-backlog.mjs';

export function partitionResearchEvidence(needs = [], evidence = []) {
  return { resolved: needs.filter(need => evidenceResolvesNeed(need, evidence)),
    unsupported: needs.filter(need => !evidenceResolvesNeed(need, evidence)) };
}

export function reassessResolvedCandidates({ registry, runId, jobIds, policy, selectionPolicy, clock = () => new Date() }) {
  const scope = new Set(jobIds); let reassessed = 0;
  for (const item of registry.listCandidateReassessmentQueue({ status: 'PENDING', limit: 1000 }).filter(item => scope.has(item.jobId))) {
    const candidate = registry.listCandidateSelectionInputs({ jobId: item.jobId })[0];
    if (candidate) {
      const assessment = registry.recordAssessment(candidate.jobId, candidate.observationId, assessOpportunity(candidate, policy, { calculatedAt: clock().toISOString() }));
      registry.syncCandidateResearchNeeds({ selectionRunId: runId, assessmentId: assessment.id, jobId: candidate.jobId, observationId: candidate.observationId,
        needs: assessment.result.eligibility.researchNeeds, versions: { unifiedPolicyVersion: UNIFIED_CANDIDATE_POLICY_VERSION,
          eligibilityRulesVersion: assessment.eligibilityRulesVersion, completenessVersion: EVIDENCE_COMPLETENESS_VERSION,
          researchNeedsVersion: RESEARCH_NEEDS_VERSION }, policyHash: policy.policyHash });
      reassessed++;
    }
    registry.markCandidateReassessmentProcessed(item.id, { processedAt: clock().toISOString() });
  }
  const active = registry.listActiveCandidates(); const assessments = registry.getLatestAssessmentsForJobs(active.map(item => item.jobId));
  const previousRanks = registry.getPreviousPriorityRanks(runId, active.map(item => item.jobId));
  const snapshot = buildDailyPrioritySnapshot({ runId, snapshotDate: clock().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }), activeCandidates: active, assessments, previousRanks, policy: selectionPolicy });
  registry.recordDailyPrioritySnapshot(runId, snapshot, { createdAt: clock().toISOString() });
  return { reassessed, active, assessments, snapshot };
}

export async function runBrowserEnrichment({ registry, sessionManager, selection = null, selectionResolver = null,
  browserAdapter, maxTasks = 5, executionBudget = {}, runId = randomUUID(), clock = () => new Date(), profilePath, portalsPath, onTask = null } = {}) {
  if (!registry || !sessionManager || (!selection && !selectionResolver) || !browserAdapter) throw new TypeError('Browser Enrichment dependencies are required');
  const startedAt = clock().toISOString(); registry.startRun({ id: runId, type: 'browser-enrichment', startedAt, metadata: { mode: 'ENRICHMENT', researchOnly: true } });
  const operational = registry.getOperationalCandidateData(); const candidates = registry.listCandidateSelectionInputs();
  const activeIds = new Set(operational.activeCandidates.map(item => item.jobId));
  const admission = selectPipelineAdmission(registry.getControlPlaneData({ candidateScope: 'active', includeAttention: false }));
  const traceByJob = new Map(admission.trace.map(item => [item.jobId, item]));
  const tasks = new PriorityResearchPlanner({ maxTasks }).plan({ needs: operational.researchNeeds.filter(item => activeIds.has(item.jobId)
    && isQualificationBlockingResearch(item, traceByJob.get(item.jobId))), candidates, snapshot: operational.snapshot });
  let session; const results = []; const before = Object.fromEntries(['ELIGIBLE','UNKNOWN','INELIGIBLE'].map(status => [status, registry.getLatestAssessmentsForJobs(operational.activeCandidates.map(item => item.jobId)).filter(item => item.eligibilityStatus === status).length]));
  try {
    session = await sessionManager.acquire(selection || selectionResolver()); await browserAdapter.start?.(session);
    for (const task of tasks) {
      const semantic = await browserAdapter.semanticDiscover({ task, runbook: browserRunbookForTask(task, { ...executionBudget, maxCards: 1, maxDetails: 1 }) });
      registry.recordBrowserTaskTelemetry(runId, semantic.telemetry, { mode: 'ENRICHMENT' });
      const candidate = candidates.find(item => item.jobId === task.jobId); const record = semantic.records[0] || {};
      if (!semantic.ok || !semantic.records.length) {
        for (const need of task.needs) registry.blockCandidateResearchNeed(need.id, { reason: semantic.outcome, evidence: [] });
        results.push({ taskId: task.id, jobId: task.jobId, outcome: semantic.outcome, resolved: 0 }); onTask?.(results.at(-1)); continue;
      }
      const identity = validateCandidateIdentity(candidate, record);
      if (!identity.valid) {
        for (const need of task.needs) registry.blockCandidateResearchNeed(need.id, { reason: identity.code, evidence: [identity] });
        results.push({ taskId: task.id, jobId: task.jobId, outcome: identity.code, resolved: 0 }); onTask?.(results.at(-1)); continue;
      }
      const evidence = extractCandidateEvidence(record, { source: task.source, retrievedAt: semantic.telemetry.finishedAt });
      let observation = null;
      if (evidence.length) observation = registry.recordObservation(runId, {
        provider: 'browser:enrichment', providerVersion: '1', sourceUrl: candidate.sourceUrl, canonicalUrl: candidate.canonicalUrl || candidate.sourceUrl,
        externalId: '', title: candidate.title, company: candidate.company, location: record.location || candidate.location,
        description: evidence.find(item => item.field === 'description')?.value || candidate.description,
        retrievedAt: semantic.telemetry.finishedAt, extractionMethod: 'parsed', confidence: identity.confidence,
        evidence, rawMetadata: { ...(candidate.rawMetadata || {}), browserEnrichment: true,
          employmentType: evidence.find(item => item.field === 'employmentType')?.value,
          salary: evidence.find(item => item.field === 'compensation')?.value,
          companyMarket: evidence.find(item => item.field === 'companyMarket')?.value,
          remoteScope: evidence.find(item => item.field === 'remoteScope')?.value,
          eligibleCountries: evidence.find(item => item.field === 'eligibleCountries')?.value,
          schedule: evidence.find(item => item.field === 'schedule')?.value },
      });
      let resolved = 0;
      const partition = partitionResearchEvidence(task.needs, evidence);
      for (const need of partition.resolved) { registry.resolveCandidateResearchNeed(need.id, { evidence, resolvedAt: semantic.telemetry.finishedAt }); resolved++; }
      for (const need of partition.unsupported) registry.blockCandidateResearchNeed(need.id, {
        reason: 'INSUFFICIENT_CANONICAL_EVIDENCE', evidence: [{ sourceUrl: task.url, inspectedAt: semantic.telemetry.finishedAt }],
      });
      results.push({ taskId: task.id, jobId: task.jobId, outcome: semantic.outcome, identity, evidence: evidence.length, observation, resolved }); onTask?.(results.at(-1));
    }
    const policy = loadOpportunityPolicy({ profilePath, portalsPath }); const selectionPolicy = loadCandidateSelectionPolicy({ profilePath, portalsPath });
    const { active, assessments, snapshot } = reassessResolvedCandidates({ registry, runId, jobIds: results.map(item => item.jobId), policy, selectionPolicy, clock });
    const after = Object.fromEntries(['ELIGIBLE','UNKNOWN','INELIGIBLE'].map(status => [status, assessments.filter(item => item.eligibilityStatus === status).length]));
    registry.finishRun(runId, { status: results.some(item => !['SUCCESS_RESULTS','SUCCESS_EMPTY'].includes(item.outcome)) ? 'PARTIAL' : 'SUCCESS', finishedAt: clock().toISOString(), metadata: { mode: 'ENRICHMENT', tasks: tasks.length, noPackages: true, noSheet: true } });
    return { status: registry.getRun(runId).status, runId, tasksPlanned: tasks.length, results, before, after, top10: snapshot.top10.length, packagesGenerated: 0, sheetUpdated: false };
  } catch (error) {
    registry.recordRunFailure(runId, { provider: 'browser-enrichment', code: error.code || 'ENRICHMENT_FAILED', message: error.message, retryable: false });
    registry.finishRun(runId, { status: 'FAILED', finishedAt: clock().toISOString() }); throw error;
  } finally { try { await browserAdapter.close?.(); } catch {} if (session) await sessionManager.release(session); }
}
