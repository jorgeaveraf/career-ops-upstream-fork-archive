import { selectPipelineAdmission } from '../intelligence/pipeline-admission.mjs';

export const TODAY_TARGET = 10;
export const TODAY_ACTIVE_CAPACITY = TODAY_TARGET;

export const TODAY_ADMISSION_REASONS = Object.freeze({
  CURATED_PIPELINE_ITEM: 'CURATED_PIPELINE_ITEM',
  HUMAN_CARRYOVER: 'HUMAN_CARRYOVER',
  HUMAN_ACTION: 'HUMAN_CARRYOVER',
  PINNED: 'HUMAN_CARRYOVER',
  HELD_VISIBLE: 'HUMAN_CARRYOVER',
});

export const TODAY_REFILL_OUTCOMES = Object.freeze({ FILLED: 'FILLED', EXHAUSTED: 'EXHAUSTED', BLOCKED: 'BLOCKED' });

const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();
const byJob = values => new Map((values || []).map(value => [value.jobId, value]));
const stateMap = values => new Map((values || []).map(value => [`${value.entityType}:${value.entityId}:${value.field}`, value.value]));
const human = (states, jobId, field, fallback = '') => states.get(`JOB:${jobId}:${field}`) ?? fallback;

function carryoverOrder(a, b) {
  const weight = { APPLICATION_HUMAN_INPUT_REQUIRED: 0, REAUTHORIZATION_REQUIRED: 1, EVALUATION_OR_PACKAGE_REVIEW_REQUIRED: 2, GOVERNED_WORKFLOW_ACTIVE: 3, EXPLICIT_HUMAN_HOLD: 4 };
  return (weight[a.admissionDetail] ?? 9) - (weight[b.admissionDetail] ?? 9)
    || Number(b.finalPriority ?? -1) - Number(a.finalPriority ?? -1)
    || text(a.jobId).localeCompare(text(b.jobId));
}

function humanCarryover(item, context) {
  const jobId = item.job.id;
  const execution = context.executions.get(jobId);
  const enrichment = context.enrichments.get(jobId);
  const snapshot = context.snapshots.get(jobId);
  const decision = upper(human(context.states, jobId, 'human_decision', 'NO_ACTION')) || 'NO_ACTION';
  const applicationDecision = upper(human(context.states, jobId, 'application_decision', 'NO_ACTION')) || 'NO_ACTION';
  const applicationStatus = upper(human(context.states, jobId, 'application_status', 'NO_OUTCOME')) || 'NO_OUTCOME';
  const executionStatus = upper(execution?.status);
  const enrichmentStatus = upper(enrichment?.status);
  const base = { jobId, item, snapshot, execution, enrichment, decision, applicationDecision,
    finalPriority: Number(snapshot?.finalPriorityScore ?? item.assessment?.finalPriorityScore ?? 0),
    held: false, pinned: true, pursuitEligible: false, pipelineRank: null,
    admissionReason: TODAY_ADMISSION_REASONS.HUMAN_CARRYOVER };
  if (decision === 'REJECT' || applicationDecision === 'REJECT' || executionStatus === 'APPLIED'
      || ['REJECTED', 'REJECTED_BY_COMPANY', 'WITHDRAWN', 'HIRED'].includes(applicationStatus)) return null;
  const reauthorization = applicationDecision === 'HOLD' && executionStatus === 'CANCELLED' && enrichmentStatus === 'READY_FOR_REVIEW';
  if (reauthorization) return { ...base, admissionDetail: 'REAUTHORIZATION_REQUIRED' };
  if (executionStatus === 'NEEDS_HUMAN') return { ...base, admissionDetail: 'APPLICATION_HUMAN_INPUT_REQUIRED' };
  if (enrichmentStatus === 'READY_FOR_REVIEW' && decision === 'NEXT_STAGE' && !['APPROVE_TO_APPLY', 'REJECT'].includes(applicationDecision)) {
    return { ...base, admissionDetail: 'EVALUATION_OR_PACKAGE_REVIEW_REQUIRED' };
  }
  const trueHold = decision === 'HOLD' || applicationDecision === 'HOLD';
  if (trueHold) return { ...base, held: true, admissionDetail: 'EXPLICIT_HUMAN_HOLD' };
  const governed = executionStatus === 'EXECUTING' || applicationDecision === 'APPROVE_TO_APPLY'
    || ['PENDING', 'RESEARCHING', 'EVALUATING', 'GENERATING_PACKAGE'].includes(enrichmentStatus)
    || (decision === 'NEXT_STAGE' && !['FAILED', 'BLOCKED', 'CANCELLED', 'READY_FOR_REVIEW'].includes(enrichmentStatus));
  return governed ? { ...base, admissionDetail: 'GOVERNED_WORKFLOW_ACTIVE' } : null;
}

/** V4.7 TODAY = Pipeline ranks 1..10 plus governed lifecycle carryovers. */
export function selectTodayMembership(data = {}, { capacity = TODAY_TARGET, pipeline = null } = {}) {
  const target = Math.max(0, Number(capacity) || 0);
  const pipelineSelection = pipeline || selectPipelineAdmission(data);
  const curated = pipelineSelection.admitted.slice(0, target).map(value => Object.freeze({
    ...value, job: value.item, pursuitEligible: true, admissible: true, held: value.decision === 'HOLD',
    pinned: value.decision === 'HOLD', admissionReason: TODAY_ADMISSION_REASONS.CURATED_PIPELINE_ITEM,
    admissionDetail: value.decision === 'HOLD' ? 'STRONG_PIPELINE_HELD' : 'PIPELINE_TOP_RANK',
  }));
  const curatedIds = new Set(curated.map(value => value.jobId));
  const context = {
    states: stateMap(data.humanState), snapshots: byJob(data.candidateSelection?.snapshot),
    enrichments: byJob(data.enrichmentRequests), executions: byJob(data.applicationExecutions),
  };
  const carryovers = [...new Map((data.jobs || []).map(item => [item.job.id, item])).values()]
    .filter(item => !curatedIds.has(item.job.id)).map(item => humanCarryover(item, context)).filter(Boolean).sort(carryoverOrder);
  const members = [...curated, ...carryovers];
  const pipelineExhausted = pipelineSelection.admitted.length < target;
  const outcome = pipelineExhausted ? TODAY_REFILL_OUTCOMES.EXHAUSTED : TODAY_REFILL_OUTCOMES.FILLED;
  const trace = [
    ...curated.map(value => Object.freeze({ jobId: value.jobId, company: value.item.job.company, role: value.item.job.title,
      pipelineRank: value.pipelineRank, result: 'ADMITTED', admissionReason: value.admissionReason, exactRule: value.admissionDetail })),
    ...pipelineSelection.admitted.slice(target).map(value => Object.freeze({ jobId: value.jobId, company: value.item.job.company,
      role: value.item.job.title, pipelineRank: value.pipelineRank, result: 'EXCLUDED', admissionReason: null, exactRule: 'OUTSIDE_PIPELINE_TOP_10' })),
    ...carryovers.map(value => Object.freeze({ jobId: value.jobId, company: value.item.job.company, role: value.item.job.title,
      pipelineRank: null, result: 'ADMITTED', admissionReason: value.admissionReason, exactRule: value.admissionDetail })),
  ];
  const diagnostics = Object.freeze({
    target, pipelineStrongCandidates: pipelineSelection.admitted.length,
    todayCuratedFromPipeline: curated.length, humanCarryovers: carryovers.length,
    currentCount: members.length, visibleVacantSlots: Math.max(0, target - members.length),
    vacantSlots: Math.max(0, target - curated.length), outcome,
    candidatesConsidered: pipelineSelection.admitted.length, candidatesAdmitted: members.length,
    admitted: Object.freeze(members.map(value => Object.freeze({ jobId: value.jobId, company: value.item.job.company,
      role: value.item.job.title, rank: value.pipelineRank, finalPriority: value.finalPriority,
      admissionReason: value.admissionReason, detail: value.admissionDetail }))),
    excludedByRule: Object.freeze(pipelineSelection.admitted.length > target ? [{ rule: 'OUTSIDE_PIPELINE_TOP_10', count: pipelineSelection.admitted.length - target }] : []),
    blockedCandidates: Object.freeze([]), admissibleRemainder: Math.max(0, pipelineSelection.admitted.length - curated.length),
    exhaustionResult: pipelineExhausted ? 'PIPELINE_STRONG_CANDIDATE_UNIVERSE_EXHAUSTED' : null,
    trace: Object.freeze(trace),
  });
  return Object.freeze({
    target, capacity: target, outcome, diagnostics, pipeline: pipelineSelection,
    curated: Object.freeze(curated), carryovers: Object.freeze(carryovers),
    pinned: Object.freeze(carryovers.filter(value => value.pinned)), held: Object.freeze(members.filter(value => value.held)),
    members: Object.freeze(members), curatedJobIds: Object.freeze(curated.map(value => value.jobId)),
    carryoverJobIds: Object.freeze(carryovers.map(value => value.jobId)), pinnedJobIds: Object.freeze(carryovers.map(value => value.jobId)),
    memberJobIds: Object.freeze(members.map(value => value.jobId)),
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
