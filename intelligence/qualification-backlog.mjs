export const QUALIFICATION_BACKLOG_VERSION = '4.8.0';

const timestamp = value => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

/** Derive qualification work from canonical Registry state. This is diagnostic
 * state, not a second queue or ranking engine. */
export function summarizeQualificationBacklog(data = {}, admission = null, { now = new Date() } = {}) {
  const trace = admission?.trace || [];
  const active = data.candidateSelection?.activeCandidates;
  const activeIds = Array.isArray(active) ? new Set(active.map(item => item.jobId)) : null;
  const research = (data.candidateSelection?.researchNeeds || []).filter(item => !activeIds || activeIds.has(item.jobId));
  const eligibility = trace.filter(item => item.exactRule === 'ELIGIBILITY_NOT_RESOLVED');
  const evaluation = trace.filter(item => item.exactRule === 'EVALUATION_NOT_READY');
  const researchIds = new Set(research.map(item => item.jobId));
  const pendingIds = new Set([...eligibility, ...evaluation].map(item => item.jobId));
  for (const id of researchIds) pendingIds.add(id);
  const dates = [
    ...research.flatMap(item => [item.createdAt, item.updatedAt]),
    ...(data.jobs || []).filter(item => pendingIds.has(item.job?.id)).flatMap(item => [item.job?.lastSeenAt]),
  ].map(timestamp).filter(Number.isFinite);
  const oldestPendingAt = dates.length ? new Date(Math.min(...dates)).toISOString() : null;
  const oldestPendingHours = oldestPendingAt == null ? 0 : Math.max(0, Math.floor((now.getTime() - Date.parse(oldestPendingAt)) / 3_600_000));
  const status = pendingIds.size ? (oldestPendingHours > 72 ? 'SLA_BREACHED' : 'PROCESSING') : 'CLEAR';
  return Object.freeze({
    version: QUALIFICATION_BACKLOG_VERSION,
    status,
    pendingCandidates: pendingIds.size,
    eligibilityPending: eligibility.length,
    evaluationPending: evaluation.length,
    researchPending: research.length,
    researchCandidateCount: researchIds.size,
    reassessmentPending: data.candidateSelection?.reassessmentQueue?.length || 0,
    oldestPendingAt,
    oldestPendingHours,
    exhausted: pendingIds.size === 0,
  });
}
