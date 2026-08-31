export const QUALIFICATION_BACKLOG_VERSION = '4.8.0';

export const BLOCKING_RESEARCH_NEEDS = Object.freeze(new Set([
  'FETCH_FULL_DESCRIPTION', 'CONFIRM_MEXICO_ELIGIBILITY', 'CONFIRM_REMOTE_SCOPE',
  'CONFIRM_EMPLOYMENT_MODEL', 'RESOLVE_LOCATION_CONFLICT', 'CONFIRM_POSTING_STATUS', 'CONFIRM_POSTING_IS_REAL',
]));
const ELIGIBILITY_RESEARCH_NEEDS = new Set([
  'FETCH_FULL_DESCRIPTION', 'CONFIRM_MEXICO_ELIGIBILITY', 'CONFIRM_REMOTE_SCOPE',
  'RESOLVE_LOCATION_CONFLICT', 'CONFIRM_POSTING_STATUS', 'CONFIRM_POSTING_IS_REAL',
]);

export function isQualificationBlockingResearch(need, traceItem) {
  if (!traceItem || !BLOCKING_RESEARCH_NEEDS.has(need?.type)) return false;
  if (traceItem.exactRule === 'ELIGIBILITY_NOT_RESOLVED') return ELIGIBILITY_RESEARCH_NEEDS.has(need.type);
  return ['INSUFFICIENT_EVIDENCE', 'EVIDENCE_CONFIDENCE_BELOW_THRESHOLD'].includes(traceItem.exactRule);
}

const timestamp = value => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

/** Derive qualification work from canonical Registry state. This is diagnostic
 * state, not a second queue or ranking engine. */
export function summarizeQualificationBacklog(data = {}, admission = null, { now = new Date() } = {}) {
  const trace = admission?.trace || [];
  const traceByJob = new Map(trace.map(item => [item.jobId, item]));
  const active = data.candidateSelection?.activeCandidates;
  const activeIds = Array.isArray(active) ? new Set(active.map(item => item.jobId)) : null;
  const latestAssessment = new Map((data.jobs || []).map(item => [item.job?.id, item.assessment?.id]).filter(([, id]) => id));
  const research = (data.candidateSelection?.researchNeeds || []).filter(item => (!activeIds || activeIds.has(item.jobId))
    && (!latestAssessment.has(item.jobId) || item.assessmentId === latestAssessment.get(item.jobId)));
  const blockingResearch = research.filter(item => isQualificationBlockingResearch(item, traceByJob.get(item.jobId)));
  const runnableResearch = blockingResearch.filter(item => item.status === 'OPEN');
  const externallyBlockedResearch = blockingResearch.filter(item => item.status === 'BLOCKED');
  const eligibility = trace.filter(item => item.exactRule === 'ELIGIBILITY_NOT_RESOLVED');
  const evaluation = trace.filter(item => item.exactRule === 'EVALUATION_NOT_READY');
  const researchIds = new Set(blockingResearch.map(item => item.jobId));
  const pendingIds = new Set([...eligibility, ...evaluation].map(item => item.jobId));
  for (const id of researchIds) pendingIds.add(id);
  const runnableIds = new Set([...evaluation.map(item => item.jobId), ...runnableResearch.map(item => item.jobId)]);
  const dates = [
    ...blockingResearch.flatMap(item => [item.createdAt, item.updatedAt]),
    ...(data.jobs || []).filter(item => pendingIds.has(item.job?.id)).flatMap(item => [item.job?.lastSeenAt]),
  ].map(timestamp).filter(Number.isFinite);
  const oldestPendingAt = dates.length ? new Date(Math.min(...dates)).toISOString() : null;
  const oldestPendingHours = oldestPendingAt == null ? 0 : Math.max(0, Math.floor((now.getTime() - Date.parse(oldestPendingAt)) / 3_600_000));
  const status = runnableIds.size ? (oldestPendingHours > 72 ? 'SLA_BREACHED' : 'PROCESSING')
    : pendingIds.size ? 'DEGRADED_EXTERNAL' : 'CLEAR';
  return Object.freeze({
    version: QUALIFICATION_BACKLOG_VERSION,
    status,
    pendingCandidates: pendingIds.size,
    eligibilityPending: eligibility.length,
    evaluationPending: evaluation.length,
    researchPending: research.length,
    researchCandidateCount: new Set(research.map(item => item.jobId)).size,
    activeBlockingResearch: blockingResearch.length,
    runnableBlockingResearch: runnableResearch.length,
    externallyBlockedResearch: externallyBlockedResearch.length,
    nonBlockingResearch: research.length - blockingResearch.length,
    runnableInternalCandidates: runnableIds.size,
    reassessmentPending: data.candidateSelection?.reassessmentQueue?.length || 0,
    oldestPendingAt,
    oldestPendingHours,
    exhausted: pendingIds.size === 0,
  });
}
