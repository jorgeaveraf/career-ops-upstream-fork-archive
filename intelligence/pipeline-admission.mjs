export const PIPELINE_POLICY_VERSION = '4.7.0';

export const PIPELINE_ADMISSION_THRESHOLDS = Object.freeze({
  minimumCandidateFit: 75,
  minimumDeepFit: 70,
  minimumOpportunityQuality: 70,
  minimumFinalPriority: 75,
  minimumDescriptionCharacters: 300,
  minimumEvidenceConfidence: 'MEDIUM',
});

export const PIPELINE_ADMISSION_RESULTS = Object.freeze({
  ADMITTED: 'ADMITTED_PIPELINE',
  EXCLUDED: 'EXCLUDED_PIPELINE',
});

const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();
const byJob = values => new Map((values || []).map(value => [value.jobId, value]));
const stateMap = values => new Map((values || []).map(value => [`${value.entityType}:${value.entityId}:${value.field}`, value.value]));
const human = (states, jobId, field, fallback = '') => states.get(`JOB:${jobId}:${field}`) ?? fallback;
const number = value => Number.isFinite(Number(value)) ? Number(value) : null;

function evidenceConfidence(item) {
  const completeness = item.assessment?.result?.eligibility?.signals?.evidenceCompleteness || {};
  const critical = ['description', 'geography', 'employment'].map(key => upper(completeness[key]?.status));
  if (critical.some(status => ['MISSING', 'CONFLICTING', 'UNKNOWN', ''].includes(status))) return 'LOW';
  if (upper(item.assessment?.confidence) === 'LOW' || upper(item.job.identityConfidence) === 'LOW') return 'LOW';
  const supporting = ['compensation', 'schedule', 'companyMarket', 'posting'].map(key => upper(completeness[key]?.status));
  return supporting.some(status => ['MISSING', 'CONFLICTING', 'UNKNOWN', ''].includes(status)) ? 'MEDIUM' : 'HIGH';
}

function orderPipeline(a, b) {
  return Number(b.finalPriority ?? -1) - Number(a.finalPriority ?? -1)
    || Number(b.candidateFit ?? -1) - Number(a.candidateFit ?? -1)
    || Number(b.opportunityQuality ?? -1) - Number(a.opportunityQuality ?? -1)
    || Number(b.deepFit ?? -1) - Number(a.deepFit ?? -1)
    || Number(a.sourceRank ?? 999999) - Number(b.sourceRank ?? 999999)
    || text(a.jobId).localeCompare(text(b.jobId));
}

function excluded(base, reason) {
  return { ...base, admitted: false, result: PIPELINE_ADMISSION_RESULTS.EXCLUDED, reason };
}

function evaluate(item, context, thresholds) {
  const jobId = item.job.id;
  const snapshot = context.snapshots.get(jobId);
  const active = context.active.get(jobId);
  const execution = context.executions.get(jobId);
  const decision = upper(human(context.states, jobId, 'human_decision', 'NO_ACTION')) || 'NO_ACTION';
  const applicationDecision = upper(human(context.states, jobId, 'application_decision', 'NO_ACTION')) || 'NO_ACTION';
  const applicationStatus = upper(human(context.states, jobId, 'application_status', 'NO_OUTCOME')) || 'NO_OUTCOME';
  const eligibility = upper(snapshot?.eligibilityStatus || item.assessment?.eligibilityStatus);
  const shortlist = upper(snapshot?.decision || item.assessment?.decision);
  const recommendation = upper(item.evaluation?.recommendation || 'UNKNOWN');
  const evaluationStatus = upper(item.evaluation?.status || (item.evaluation?.recommendation ? 'VALID' : 'UNKNOWN'));
  const candidateFit = number(item.assessment?.result?.candidateFit?.score ?? item.assessment?.candidateFitScore);
  const opportunityQuality = number(item.assessment?.result?.opportunity?.score ?? item.assessment?.opportunityScore);
  const finalPriority = number(snapshot?.finalPriorityScore ?? item.assessment?.finalPriorityScore);
  const deepFit = number(item.evaluation?.overallFit ?? item.evaluation?.overall_fit ?? item.evaluation?.evaluation?.overall_fit);
  const evidence = evidenceConfidence(item);
  const employmentModel = text(item.assessment?.result?.eligibility?.signals?.employmentModel
    || item.assessment?.result?.eligibility?.signals?.employment?.model || item.assessment?.employmentModel);
  const sourceRank = number(snapshot?.rank);
  const base = {
    jobId, item, snapshot, active, execution, decision, applicationDecision, applicationStatus,
    eligibility, shortlist, recommendation, evaluationStatus, candidateFit, opportunityQuality,
    finalPriority, deepFit, evidenceConfidence: evidence, employmentModel, sourceRank,
    policyVersion: PIPELINE_POLICY_VERSION,
  };

  if (decision === 'REJECT') return excluded(base, 'HUMAN_REJECTED');
  if (applicationDecision === 'REJECT') return excluded(base, 'APPLICATION_REJECTED');
  if (upper(execution?.status) === 'APPLIED') return excluded(base, 'TERMINAL_APPLIED');
  if (['REJECTED', 'REJECTED_BY_COMPANY', 'WITHDRAWN', 'HIRED'].includes(applicationStatus)) return excluded(base, `TERMINAL_${applicationStatus}`);
  if (['APPLIED', 'REJECTED', 'CLOSED', 'EXPIRED', 'WITHDRAWN'].includes(upper(item.job.status))) return excluded(base, 'STALE_OR_CLOSED');
  if (['DISCARDED', 'ACTED', 'EXPIRED'].includes(upper(active?.state))) return excluded(base, 'STALE_OR_CLOSED');
  if (eligibility !== 'ELIGIBLE') return excluded(base, eligibility === 'INELIGIBLE' ? 'HARD_STOP_INELIGIBLE' : 'ELIGIBILITY_NOT_RESOLVED');
  if (evaluationStatus !== 'VALID' || !item.evaluation) return excluded(base, 'EVALUATION_NOT_READY');
  if (recommendation !== 'APPLY') return excluded(base, recommendation === 'DO_NOT_APPLY' ? 'PURSUIT_DO_NOT_APPLY' : 'PURSUIT_RECOMMENDATION_UNKNOWN');
  if (shortlist !== 'SHORTLIST') return excluded(base, 'SHORTLIST_PRESELECTION_REQUIRED');
  if (text(item.job.description).length < thresholds.minimumDescriptionCharacters
      || !text(item.job.url) || upper(item.job.company) === 'UNKNOWN' || !employmentModel) {
    return excluded(base, 'INSUFFICIENT_EVIDENCE');
  }
  if (evidence === 'LOW') return excluded(base, 'EVIDENCE_CONFIDENCE_BELOW_THRESHOLD');
  if (candidateFit == null || candidateFit < thresholds.minimumCandidateFit
      || deepFit == null || deepFit < thresholds.minimumDeepFit) return excluded(base, 'FIT_BELOW_THRESHOLD');
  if (opportunityQuality == null || opportunityQuality < thresholds.minimumOpportunityQuality) return excluded(base, 'OPPORTUNITY_QUALITY_BELOW_THRESHOLD');
  if (finalPriority == null || finalPriority < thresholds.minimumFinalPriority) return excluded(base, 'FINAL_PRIORITY_BELOW_THRESHOLD');
  return { ...base, admitted: true, result: PIPELINE_ADMISSION_RESULTS.ADMITTED, reason: 'STRONG_PURSUIT_CANDIDATE' };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Canonical Registry -> strong active Pipeline admission and ranking. */
export function selectPipelineAdmission(data = {}, { thresholds = PIPELINE_ADMISSION_THRESHOLDS } = {}) {
  const context = {
    states: stateMap(data.humanState),
    snapshots: byJob(data.candidateSelection?.snapshot),
    active: byJob(data.candidateSelection?.activeCandidates),
    executions: byJob(data.applicationExecutions),
  };
  const unique = [...new Map((data.jobs || []).map(item => [item.job.id, item])).values()];
  const evaluated = unique.map(item => evaluate(item, context, thresholds));
  const admitted = evaluated.filter(value => value.admitted).sort(orderPipeline)
    .map((value, index) => Object.freeze({ ...value, pipelineRank: index + 1 }));
  const rankById = new Map(admitted.map(value => [value.jobId, value.pipelineRank]));
  const trace = evaluated.map(value => Object.freeze({
    jobId: value.jobId, company: value.item.job.company, role: value.item.job.title,
    result: value.result, exactRule: value.reason, pipelineRank: rankById.get(value.jobId) || null,
    eligibility: value.eligibility || 'UNKNOWN', evaluationStatus: value.evaluationStatus,
    recommendation: value.recommendation, shortlist: value.shortlist || 'UNKNOWN',
    candidateFit: value.candidateFit, deepFit: value.deepFit,
    opportunityQuality: value.opportunityQuality, finalPriority: value.finalPriority,
    evidenceConfidence: value.evidenceConfidence, humanDecision: value.decision,
  })).sort((a, b) => (a.pipelineRank || 999999) - (b.pipelineRank || 999999)
    || Number(b.finalPriority ?? -1) - Number(a.finalPriority ?? -1)
    || text(a.jobId).localeCompare(text(b.jobId)));
  const excludedByRule = Object.entries(trace.filter(value => value.result === PIPELINE_ADMISSION_RESULTS.EXCLUDED)
    .reduce((counts, value) => { counts[value.exactRule] = (counts[value.exactRule] || 0) + 1; return counts; }, {}))
    .sort(([a], [b]) => a.localeCompare(b)).map(([rule, count]) => Object.freeze({ rule, count }));
  const confidenceDistribution = admitted.reduce((counts, value) => {
    counts[value.evidenceConfidence] = (counts[value.evidenceConfidence] || 0) + 1; return counts;
  }, {});
  return Object.freeze({
    policyVersion: PIPELINE_POLICY_VERSION,
    thresholds,
    registryCount: unique.length,
    activeCandidates: evaluated.filter(value => !/^(?:HUMAN_REJECTED|APPLICATION_REJECTED|TERMINAL_|STALE_OR_CLOSED)/.test(value.reason)).length,
    admitted: Object.freeze(admitted),
    admittedJobIds: Object.freeze(admitted.map(value => value.jobId)),
    excludedCount: evaluated.length - admitted.length,
    excludedByRule: Object.freeze(excludedByRule),
    trace: Object.freeze(trace),
    metrics: Object.freeze({
      pipelineCount: admitted.length,
      medianCandidateFit: median(admitted.map(value => value.candidateFit)),
      medianOpportunityQuality: median(admitted.map(value => value.opportunityQuality)),
      evidenceConfidenceDistribution: Object.freeze(confidenceDistribution),
      applyRecommendationCount: admitted.filter(value => value.recommendation === 'APPLY').length,
    }),
  });
}
