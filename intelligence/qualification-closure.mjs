import { isQualificationBlockingResearch } from './qualification-backlog.mjs';

export const QUALIFICATION_CLOSURE_VERSION = '4.8.0';
const TERMINAL = new Set(['APPLIED', 'REJECTED', 'CLOSED', 'EXPIRED', 'WITHDRAWN']);
const ACTIVE = new Set(['ACTIVE', 'CARRYOVER']);
const ELIGIBILITY_BLOCKERS = new Set(['CONFIRM_MEXICO_ELIGIBILITY', 'CONFIRM_REMOTE_SCOPE', 'RESOLVE_LOCATION_CONFLICT']);

const counts = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));

/** Classify canonical active qualification work without navigating or mutating. */
export function analyzeQualificationClosure(data = {}, admission = null) {
  const active = new Map((data.candidateSelection?.activeCandidates || []).map(item => [item.jobId, item]));
  const jobs = new Map((data.jobs || []).map(item => [item.job?.id, item]));
  const trace = new Map((admission?.trace || []).map(item => [item.jobId, item]));
  const allNeeds = (data.candidateSelection?.researchNeeds || []).filter(item => active.has(item.jobId));
  const latestAssessment = new Map([...jobs].map(([jobId, item]) => [jobId, item.assessment?.id]).filter(([, id]) => id));
  const currentNeeds = allNeeds.filter(item => active.has(item.jobId)
    && (!latestAssessment.has(item.jobId) || item.assessmentId === latestAssessment.get(item.jobId)));
  const currentByJob = new Map();
  for (const need of currentNeeds) currentByJob.set(need.jobId, [...(currentByJob.get(need.jobId) || []), need]);

  const eligibility = [];
  for (const [jobId, activeItem] of active) {
    const item = jobs.get(jobId); const row = trace.get(jobId);
    if (row?.exactRule !== 'ELIGIBILITY_NOT_RESOLVED') continue;
    const needs = currentByJob.get(jobId) || [];
    const critical = needs.filter(need => ELIGIBILITY_BLOCKERS.has(need.type));
    let category = 'G_WORKER_ORCHESTRATION_ORPHAN';
    if (!ACTIVE.has(activeItem.state) || TERMINAL.has(String(item?.job?.status || '').toUpperCase())) category = 'D_STALE_CLOSED_INACTIVE';
    else if (critical.some(need => need.status === 'OPEN')) category = 'C_NEEDS_PUBLIC_EVIDENCE_RESEARCH';
    else if (critical.some(need => need.status === 'BLOCKED')) category = 'F_GENUINELY_AMBIGUOUS';
    else if ((item?.assessment?.rulesApplied || []).some(rule => ['location.conflicting_scope', 'location.unproven'].includes(rule))) category = 'F_GENUINELY_AMBIGUOUS';
    eligibility.push({ jobId, company: item?.job?.company || '', role: item?.job?.title || '', category,
      exactRule: row.exactRule, researchNeeds: critical.map(need => ({ type: need.type, status: need.status, reason: need.reason })) });
  }

  const research = allNeeds.map(need => {
    const isActive = active.has(need.jobId); const current = !latestAssessment.has(need.jobId) || need.assessmentId === latestAssessment.get(need.jobId);
    const row = trace.get(need.jobId);
    const qualificationBlocking = current && isActive && isQualificationBlockingResearch(need, row);
    const blockingEligibility = qualificationBlocking && row?.exactRule === 'ELIGIBILITY_NOT_RESOLVED' && ELIGIBILITY_BLOCKERS.has(need.type);
    const blockingStrongPool = qualificationBlocking && !blockingEligibility;
    const classification = !isActive ? 'HISTORICAL' : !current ? 'STALE_OR_DUPLICATE'
      : blockingEligibility ? 'BLOCKING_ELIGIBILITY' : blockingStrongPool ? 'BLOCKING_STRONG_POOL' : 'NON_BLOCKING';
    return { ...need, classification, active: isActive, current };
  });
  return Object.freeze({
    version: QUALIFICATION_CLOSURE_VERSION,
    eligibility: Object.freeze({ total: eligibility.length, counts: counts(eligibility.map(item => item.category)), candidates: Object.freeze(eligibility) }),
    research: Object.freeze({ raw: allNeeds.length, activeCurrent: currentNeeds.length,
      staleOrDuplicate: research.filter(item => item.classification === 'STALE_OR_DUPLICATE').length,
      historical: research.filter(item => item.classification === 'HISTORICAL').length,
      blockingEligibility: research.filter(item => item.classification === 'BLOCKING_ELIGIBILITY').length,
      blockingStrongPool: research.filter(item => item.classification === 'BLOCKING_STRONG_POOL').length,
      nonBlocking: research.filter(item => item.classification === 'NON_BLOCKING').length,
      open: currentNeeds.filter(item => item.status === 'OPEN').length,
      blocked: currentNeeds.filter(item => item.status === 'BLOCKED').length,
      counts: counts(research.map(item => item.classification)), needs: Object.freeze(research) }),
  });
}
