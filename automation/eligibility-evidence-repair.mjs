import { CandidateSelectionEngine, buildDailyPrioritySnapshot } from '../candidate-selection/engine.mjs';
import { loadCandidateSelectionPolicy } from '../candidate-selection/policy.mjs';
import { ELIGIBILITY_RULES_VERSION, RANKING_RULES_VERSION } from '../intelligence/contracts.mjs';
import { assessOpportunity } from '../intelligence/funnel.mjs';
import { loadOpportunityPolicy } from '../intelligence/profile-policy.mjs';
import { EVIDENCE_COMPLETENESS_VERSION, RESEARCH_NEEDS_VERSION, UNIFIED_CANDIDATE_POLICY_VERSION } from '../intelligence/unified-candidate-policy.mjs';

const countStatuses = assessments => Object.fromEntries(['ELIGIBLE', 'UNKNOWN', 'INELIGIBLE'].map(status => [status, assessments.filter(item => (item.eligibilityStatus || item.eligibility?.status) === status).length]));
const countNeeds = assessments => {
  const counts = {};
  for (const assessment of assessments) for (const need of assessment.result?.eligibility?.researchNeeds || assessment.eligibility?.researchNeeds || []) counts[need.type] = (counts[need.type] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort());
};
const auditEntries = entries => {
  const dimensions = ['description', 'geography', 'employment', 'compensation', 'schedule', 'companyMarket'];
  return Object.fromEntries(dimensions.map(dimension => [dimension, Object.fromEntries([...new Set(entries.map(item => item.evidenceCompleteness?.[dimension]?.status || 'UNKNOWN'))].sort().map(status => [status, entries.filter(item => (item.evidenceCompleteness?.[dimension]?.status || 'UNKNOWN') === status).length]))]));
};

export async function runEligibilityEvidenceRepair({ registry, profilePath = process.env.CAREER_OPS_PROFILE || 'config/profile.yml',
  portalsPath = process.env.CAREER_OPS_PORTALS || 'portals.yml', clock = () => new Date(), dryRun = false } = {}) {
  if (!registry) throw new TypeError('registry is required');
  const policy = loadOpportunityPolicy({ profilePath, portalsPath });
  const selectionPolicy = loadCandidateSelectionPolicy({ profilePath, portalsPath });
  const previous = registry.listActiveCandidates();
  const activeIds = new Set(previous.map(item => item.jobId));
  const candidates = registry.listCandidateSelectionInputs().filter(item => activeIds.has(item.jobId));
  const beforeAssessments = registry.getLatestAssessmentsForJobs([...activeIds]);
  const runId = `eligibility-repair-${clock().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}-v${ELIGIBILITY_RULES_VERSION}-${policy.policyHash.slice(0, 8)}`;
  const selection = new CandidateSelectionEngine({ policy: selectionPolicy, clock }).select({ candidates, previousCandidates: previous });
  const byJob = new Map(candidates.map(item => [item.jobId, item]));
  const calculated = selection.activeCandidates.map(selected => {
    const candidate = { ...byJob.get(selected.jobId), selectionScore: selected.preliminaryScore, selectionRank: selected.selectionRank };
    return { selected, candidate, assessment: assessOpportunity(candidate, policy, { calculatedAt: clock().toISOString() }) };
  });
  const previewEntries = calculated.map(({ selected, assessment }) => ({
    jobId: selected.jobId, observationId: selected.observationId, eligibilityStatus: assessment.eligibility.status,
    finalPriorityScore: assessment.finalPriority.score, candidateFitScore: assessment.candidateFit.score,
    opportunityScore: assessment.opportunity.score, decision: assessment.finalPriority.decision,
    confidence: assessment.eligibility.confidence, reasons: assessment.eligibility.reasons,
    result: assessment,
  }));
  if (dryRun) return { dryRun: true, runId, activeCandidatesBefore: previous.length, activeCandidatesAfter: selection.activeCandidates.length,
    before: countStatuses(beforeAssessments), after: countStatuses(previewEntries), researchNeeds: countNeeds(previewEntries),
    removedByPolicy: selection.transitions.map(item => ({ jobId: item.jobId, reason: item.stateReason })),
    top: [], topEvidenceCompleteness: {} };

  if (!registry.getRun(runId)) registry.startRun({ id: runId, type: 'eligibility-repair', startedAt: clock().toISOString(), metadata: { activeOnly: true, noDiscovery: true, policyHash: policy.policyHash } });
  registry.recordCandidateSelection(runId, selection, { decidedAt: clock().toISOString() });
  const stored = [];
  for (const item of calculated) {
    const assessment = registry.recordAssessment(item.selected.jobId, item.selected.observationId, item.assessment);
    stored.push(assessment);
    registry.syncCandidateResearchNeeds({ selectionRunId: runId, assessmentId: assessment.id,
      jobId: item.selected.jobId, observationId: item.selected.observationId,
      needs: assessment.result.eligibility.researchNeeds,
      versions: { unifiedPolicyVersion: UNIFIED_CANDIDATE_POLICY_VERSION, eligibilityRulesVersion: ELIGIBILITY_RULES_VERSION,
        completenessVersion: EVIDENCE_COMPLETENESS_VERSION, researchNeedsVersion: RESEARCH_NEEDS_VERSION }, policyHash: policy.policyHash });
  }
  const previousRanks = registry.getPreviousPriorityRanks(runId, selection.activeCandidates.map(item => item.jobId));
  const snapshot = buildDailyPrioritySnapshot({ runId, snapshotDate: clock().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }),
    activeCandidates: selection.activeCandidates, assessments: stored, previousRanks, policy: selectionPolicy });
  registry.recordDailyPrioritySnapshot(runId, snapshot, { createdAt: clock().toISOString() });
  registry.recordSemanticFunnelMetrics(runId, {
    RAW_DISCOVERED: previous.length, NORMALIZED: previous.length, UNIQUE_JOBS: previous.length,
    FILTER_PASS: selection.counts.PASS, FILTER_REJECT: selection.counts.REJECT, FILTER_UNKNOWN: selection.counts.UNKNOWN,
    ACTIVE_SET: selection.counts.active, ELIGIBILITY_ELIGIBLE: stored.filter(item => item.eligibilityStatus === 'ELIGIBLE').length,
    ELIGIBILITY_INELIGIBLE: stored.filter(item => item.eligibilityStatus === 'INELIGIBLE').length,
    ELIGIBILITY_UNKNOWN: stored.filter(item => item.eligibilityStatus === 'UNKNOWN').length,
    RANKED: snapshot.ranked, TOP_10: snapshot.top10.length, DEEP_EVALUATED: 0, PACKAGE_READY: 0,
  }, { scope: 'eligibility_evidence_repair' });
  registry.finishRun(runId, { status: 'SUCCESS', finishedAt: clock().toISOString(), metadata: { activeOnly: true, noDiscovery: true, policyHash: policy.policyHash } });
  return { dryRun: false, runId, activeCandidatesBefore: previous.length, activeCandidatesAfter: selection.activeCandidates.length,
    before: countStatuses(beforeAssessments), after: countStatuses(stored), researchNeeds: countNeeds(stored),
    removedByPolicy: selection.transitions.map(item => ({ jobId: item.jobId, reason: item.stateReason })),
    top: snapshot.top10.map(item => ({ jobId: item.jobId, rank: item.rank, score: item.finalPriorityScore, evidenceWeak: item.evidenceWeak })),
    topEvidenceCompleteness: auditEntries(snapshot.top10) };
}
