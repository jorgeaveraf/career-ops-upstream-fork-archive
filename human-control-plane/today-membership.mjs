export const TODAY_TARGET = 10;
// Backward-compatible name used by V4.1 callers. In V4.6 this is total TODAY
// capacity, not an additional curated-only allowance.
export const TODAY_ACTIVE_CAPACITY = TODAY_TARGET;

export const TODAY_ADMISSION_REASONS = Object.freeze({
  HUMAN_ACTION: 'HUMAN_ACTION',
  PINNED: 'PINNED',
  HELD_VISIBLE: 'HELD_VISIBLE',
});

export const TODAY_REFILL_OUTCOMES = Object.freeze({
  FILLED: 'FILLED',
  EXHAUSTED: 'EXHAUSTED',
  BLOCKED: 'BLOCKED',
});

const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();
const byJob = values => new Map((values || []).map(value => [value.jobId, value]));
const humanState = values => new Map((values || []).map(value => [`${value.entityType}:${value.entityId}:${value.field}`, value.value]));
const human = (states, jobId, field, fallback = '') => states.get(`JOB:${jobId}:${field}`) ?? fallback;
const finitePriority = value => Number.isFinite(Number(value)) ? Number(value) : null;

function stableCandidateOrder(a, b) {
  return Number(b.priorityScore ?? -1) - Number(a.priorityScore ?? -1)
    || Number(b.job?.assessment?.result?.candidateFit?.score || b.job?.assessment?.candidateFitScore || 0)
      - Number(a.job?.assessment?.result?.candidateFit?.score || a.job?.assessment?.candidateFitScore || 0)
    || Number(a.sourceRank || 999999) - Number(b.sourceRank || 999999)
    || text(a.jobId).localeCompare(text(b.jobId));
}

function admissionOrder(a, b) {
  const detailWeight = {
    APPLICATION_HUMAN_INPUT_REQUIRED:0, REAUTHORIZATION_REQUIRED:0,
    EVALUATION_OR_PACKAGE_REVIEW_REQUIRED:0, GOVERNED_WORKFLOW_ACTIVE:1,
    EXPLICIT_HUMAN_HOLD:2, PRIORITIZED_OPPORTUNITY_DECISION_REQUIRED:3,
  };
  return (detailWeight[a.admissionDetail] ?? 9) - (detailWeight[b.admissionDetail] ?? 9)
    || stableCandidateOrder(a, b);
}

function evaluateCandidate(job, context) {
  const jobId = job.job.id;
  const snapshot = context.snapshots.get(jobId);
  const active = context.active.get(jobId);
  const decision = upper(human(context.states, jobId, 'human_decision', 'NO_ACTION')) || 'NO_ACTION';
  const applicationDecision = upper(human(context.states, jobId, 'application_decision', 'NO_ACTION')) || 'NO_ACTION';
  const applicationStatus = upper(human(context.states, jobId, 'application_status', 'NO_OUTCOME')) || 'NO_OUTCOME';
  const recommendation = upper(job.evaluation?.recommendation || 'UNKNOWN');
  const evaluationStatus = upper(job.evaluation?.status || (job.evaluation?.recommendation ? 'VALID' : 'UNKNOWN'));
  const execution = context.executions.get(jobId);
  const enrichment = context.enrichments.get(jobId);
  const executionStatus = upper(execution?.status);
  const enrichmentStatus = upper(enrichment?.status);
  const eligible = upper(snapshot?.eligibilityStatus || job.assessment?.eligibilityStatus);
  const shortlistDecision = upper(snapshot?.decision || job.assessment?.decision);
  const priorityScore = finitePriority(snapshot?.finalPriorityScore ?? job.assessment?.finalPriorityScore);
  const sourceRank = Number(snapshot?.rank || 999999);
  const activeState = upper(active?.state);

  const base = {
    jobId, job, snapshot, active, enrichment, execution, decision, applicationDecision,
    applicationStatus, recommendation, evaluationStatus, executionStatus, enrichmentStatus,
    eligible, shortlistDecision, priorityScore, sourceRank, activeState,
    terminal: false, held: false, pinned: false, pursuitEligible: false,
    admissible: false, admissionReason: null, admissionDetail: '', exclusionRule: null,
    blocked: false,
  };

  if (decision === 'REJECT') return { ...base, terminal:true, exclusionRule:'TERMINAL_HUMAN_REJECT' };
  if (applicationDecision === 'REJECT') return { ...base, terminal:true, exclusionRule:'TERMINAL_APPLICATION_REJECT' };
  if (executionStatus === 'APPLIED') return { ...base, terminal:true, exclusionRule:'TERMINAL_APPLICATION_APPLIED' };
  if (['REJECTED','REJECTED_BY_COMPANY','WITHDRAWN','HIRED'].includes(applicationStatus)) {
    return { ...base, terminal:true, exclusionRule:`TERMINAL_APPLICATION_OUTCOME_${applicationStatus}` };
  }
  if (activeState === 'DISCARDED') return { ...base, terminal:true, exclusionRule:'TERMINAL_ACTIVE_CANDIDATE_DISCARDED' };

  const reauthorizationRequired = applicationDecision === 'HOLD'
    && executionStatus === 'CANCELLED' && enrichmentStatus === 'READY_FOR_REVIEW';
  const executionHumanAction = executionStatus === 'NEEDS_HUMAN';
  const reviewHumanAction = enrichmentStatus === 'READY_FOR_REVIEW'
    && !['APPROVE_TO_APPLY','REJECT'].includes(applicationDecision)
    && (decision === 'NEXT_STAGE' || reauthorizationRequired);
  if (executionHumanAction || reviewHumanAction || reauthorizationRequired) {
    return { ...base, admissible:true, pinned:true, admissionReason:TODAY_ADMISSION_REASONS.HUMAN_ACTION,
      admissionDetail:reauthorizationRequired?'REAUTHORIZATION_REQUIRED':executionHumanAction?'APPLICATION_HUMAN_INPUT_REQUIRED':'EVALUATION_OR_PACKAGE_REVIEW_REQUIRED' };
  }

  const trueHold = decision === 'HOLD' || applicationDecision === 'HOLD';
  if (trueHold) {
    return { ...base, held:true, pinned:true, admissible:true,
      admissionReason:TODAY_ADMISSION_REASONS.HELD_VISIBLE, admissionDetail:'EXPLICIT_HUMAN_HOLD' };
  }

  const backgroundActive = executionStatus === 'EXECUTING'
    || applicationDecision === 'APPROVE_TO_APPLY'
    || ['PENDING','RESEARCHING','EVALUATING','GENERATING_PACKAGE'].includes(enrichmentStatus)
    || (decision === 'NEXT_STAGE' && !['FAILED','BLOCKED','CANCELLED'].includes(enrichmentStatus));
  if (backgroundActive) {
    return { ...base, pinned:true, admissible:true,
      admissionReason:TODAY_ADMISSION_REASONS.PINNED, admissionDetail:'GOVERNED_WORKFLOW_ACTIVE' };
  }

  if (['FAILED','BLOCKED'].includes(enrichmentStatus) || executionStatus === 'FAILED') {
    return { ...base, exclusionRule:'WORKFLOW_FAILED_WITHOUT_GOVERNED_HUMAN_ACTION' };
  }
  if (executionStatus === 'CANCELLED') return { ...base, exclusionRule:'HISTORICAL_CANCELLED_EXECUTION_ONLY' };
  if (eligible !== 'ELIGIBLE') return { ...base, exclusionRule:eligible === 'INELIGIBLE'?'HARD_STOP_INELIGIBLE':'ELIGIBILITY_NOT_RESOLVED' };
  if (shortlistDecision !== 'SHORTLIST') return { ...base, exclusionRule:'NOT_SHORTLISTED_BY_RANKING_POLICY' };
  if (recommendation === 'DO_NOT_APPLY') return { ...base, exclusionRule:'MACHINE_DO_NOT_APPLY_WITHOUT_UNRESOLVED_HUMAN_WORK' };
  if (recommendation !== 'APPLY' || evaluationStatus !== 'VALID') {
    return { ...base, exclusionRule:'MACHINE_EVALUATION_NOT_READY' };
  }
  if (priorityScore == null) {
    return { ...base, blocked:true, exclusionRule:'REQUIRED_PRIORITY_MISSING' };
  }

  return { ...base, pursuitEligible:true, admissible:true,
    admissionReason:TODAY_ADMISSION_REASONS.HUMAN_ACTION, admissionDetail:'PRIORITIZED_OPPORTUNITY_DECISION_REQUIRED' };
}

/**
 * The sole deterministic policy for TODAY membership and refill.
 *
 * Every row consumes one slot. Existing Human work/pins/explicit holds are
 * selected before new curated decisions; final priority and stable registry
 * identity break ties. The complete registry-backed candidate universe is
 * evaluated so an under-target result is always EXHAUSTED or BLOCKED.
 */
export function selectTodayMembership(data = {}, { capacity = TODAY_TARGET } = {}) {
  const target = Math.max(0, Number(capacity) || 0);
  const context = {
    states: humanState(data.humanState),
    snapshots: byJob(data.candidateSelection?.snapshot),
    active: byJob(data.candidateSelection?.activeCandidates),
    enrichments: byJob(data.enrichmentRequests),
    executions: byJob(data.applicationExecutions),
  };
  const uniqueJobs = [...new Map((data.jobs || []).map(job => [job.job.id, job])).values()];
  const evaluated = uniqueJobs.map(job => evaluateCandidate(job, context));
  const admissible = evaluated.filter(value => value.admissible).sort(admissionOrder);
  const members = admissible.slice(0, target);
  const memberIds = new Set(members.map(value => value.jobId));
  const blocked = evaluated.filter(value => value.blocked);
  const outcome = members.length >= target ? TODAY_REFILL_OUTCOMES.FILLED
    : blocked.length ? TODAY_REFILL_OUTCOMES.BLOCKED : TODAY_REFILL_OUTCOMES.EXHAUSTED;
  const trace = [...evaluated].sort(stableCandidateOrder).map(value => Object.freeze({
    jobId:value.jobId, company:value.job.job.company, role:value.job.job.title,
    rank:Number.isFinite(value.sourceRank)&&value.sourceRank<999999?value.sourceRank:null,
    finalPriority:value.priorityScore, eligibility:value.eligible || 'UNKNOWN',
    lifecycle:{humanDecision:value.decision,applicationDecision:value.applicationDecision,
      enrichmentStatus:value.enrichmentStatus||'NOT_QUEUED',executionStatus:value.executionStatus||'NOT_STARTED'},
    recommendation:value.recommendation,
    result:memberIds.has(value.jobId)?'ADMITTED':'EXCLUDED',
    admissionReason:memberIds.has(value.jobId)?value.admissionReason:null,
    exactRule:memberIds.has(value.jobId)?value.admissionDetail
      : value.admissible?'TODAY_TARGET_REACHED_BY_HIGHER_PRIORITY_WORK':value.exclusionRule,
  }));
  const curated = members.filter(value => value.pursuitEligible && value.admissionDetail === 'PRIORITIZED_OPPORTUNITY_DECISION_REQUIRED');
  const pinned = members.filter(value => value.pinned);
  const held = members.filter(value => value.held);
  const diagnostics = Object.freeze({
    target, currentCount:members.length, vacantSlots:Math.max(0,target-members.length),
    outcome, candidatesConsidered:trace.length, candidatesAdmitted:members.length,
    admitted:Object.freeze(members.map(value=>Object.freeze({jobId:value.jobId,company:value.job.job.company,
      role:value.job.job.title,rank:Number.isFinite(value.sourceRank)&&value.sourceRank<999999?value.sourceRank:null,
      finalPriority:value.priorityScore,admissionReason:value.admissionReason,detail:value.admissionDetail}))),
    excludedByRule:Object.freeze(Object.entries(trace.filter(value=>value.result==='EXCLUDED').reduce((counts,value)=>{
      counts[value.exactRule]=(counts[value.exactRule]||0)+1;return counts;},{})).sort(([a],[b])=>a.localeCompare(b)).map(([rule,count])=>Object.freeze({rule,count}))),
    blockedCandidates:Object.freeze(blocked.map(value=>value.jobId)),
    admissibleRemainder:Math.max(0,admissible.length-members.length),
    exhaustionResult:outcome===TODAY_REFILL_OUTCOMES.EXHAUSTED?'ADMISSIBLE_CANDIDATE_UNIVERSE_EXHAUSTED':null,
    trace:Object.freeze(trace),
  });
  return Object.freeze({
    target, capacity:target, outcome, diagnostics,
    curated:Object.freeze(curated), pinned:Object.freeze(pinned), held:Object.freeze(held),
    members:Object.freeze(members),
    curatedJobIds:Object.freeze(curated.map(value=>value.jobId)),
    pinnedJobIds:Object.freeze(pinned.map(value=>value.jobId)),
    memberJobIds:Object.freeze(members.map(value=>value.jobId)),
  });
}

export function todayAttentionWeight({ attentionType = '', priority = '', lifecycle = '', recommendation = '' } = {}) {
  const type = upper(attentionType), level = upper(priority), state = upper(lifecycle), pursuit = upper(recommendation);
  if (type === 'VERIFICATION_REQUIRED') return 0;
  if (['ANSWER_REQUIRED', 'EXTERNAL_ACTION_REQUIRED'].includes(type) && level === 'CRITICAL') return 1;
  if (['REVIEW_REQUIRED', 'APPROVAL_REQUIRED'].includes(type) && pursuit === 'APPLY') return 2;
  if (type === 'ANSWER_REQUIRED' || type === 'EXTERNAL_ACTION_REQUIRED') return 3;
  if (type === 'DECISION_REQUIRED' && pursuit === 'APPLY') return 4;
  if (['ENRICHMENT_QUEUED', 'RESEARCHING', 'EVALUATING', 'GENERATING_PACKAGE'].includes(state)) return 5;
  if (state === 'HOLD') return 9;
  if (pursuit === 'APPLY') return 6;
  return 8;
}
