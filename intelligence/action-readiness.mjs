const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();

export const ACTION_READINESS_VERSION = '1';
export const ACTION_READINESS_STATES = Object.freeze({
  RESEARCH_REQUIRED: 'RESEARCH_REQUIRED', REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  DEEP_EVALUATION_READY: 'DEEP_EVALUATION_READY', PACKAGE_GENERATION_READY: 'PACKAGE_GENERATION_READY',
  ACTION_READY: 'ACTION_READY',
});

const CRITICAL_RESEARCH_NEEDS = new Set([
  'FETCH_FULL_DESCRIPTION', 'CONFIRM_MEXICO_ELIGIBILITY', 'CONFIRM_REMOTE_SCOPE',
  'RESOLVE_LOCATION_CONFLICT', 'CONFIRM_POSTING_STATUS', 'CONFIRM_POSTING_IS_REAL',
]);

function validHttpUrl(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }
const supported = (value, accepted = ['SUPPORTED', 'PRESENT']) => accepted.includes(upper(value?.status));

export function assessActionReadiness({
  job = {}, observation = {}, activeCandidate = null, snapshot = {}, assessment = null,
  researchNeeds = [], evaluation = null, applicationPackage = null, humanDecision = 'NO_ACTION',
} = {}) {
  const completeness = snapshot?.evidenceCompleteness || assessment?.result?.eligibility?.signals?.evidenceCompleteness || {};
  const critical = []; const nonCriticalUnknowns = [];
  const url = job.url || observation.canonicalUrl || observation.sourceUrl || '';
  const description = text(job.description || observation.description);
  const identityConfidence = upper(observation.identityConfidence || job.identityConfidence);
  const geography = completeness.geography || assessment?.result?.eligibility?.signals?.geography || {};
  const employment = completeness.employment || {}; const posting = completeness.posting || {};

  if (!activeCandidate || !['ACTIVE', 'CARRYOVER'].includes(upper(activeCandidate.state))) critical.push('NOT_ACTIVE');
  if (!validHttpUrl(url) || !['HIGH', 'MEDIUM'].includes(identityConfidence)) critical.push('IDENTITY_UNTRUSTED');
  if (snapshot?.poolOnly || ['POOL_ONLY', 'NOT_REAL', 'CONFLICTING'].includes(upper(posting.status))) critical.push('POSTING_NOT_CONFIRMED');
  if (!supported(geography, ['SUPPORTED'])) critical.push('GEOGRAPHY_NOT_SUPPORTED');
  if (description.length < 200 || !supported(completeness.description, ['PRESENT', 'SUPPORTED', 'STRONG'])) critical.push('DESCRIPTION_INSUFFICIENT');
  if (!supported(employment, ['PRESENT', 'SUPPORTED', 'STRONG'])) critical.push('EMPLOYMENT_MODEL_UNKNOWN');
  if (assessment?.eligibilityStatus !== 'ELIGIBLE' || assessment?.decision !== 'SHORTLIST') critical.push('NOT_ELIGIBLE_SHORTLIST');
  if (upper(humanDecision) === 'REJECT') critical.push('HUMAN_REJECTED');
  for (const need of researchNeeds || []) if (CRITICAL_RESEARCH_NEEDS.has(need.type)) critical.push(`OPEN_${need.type}`);
  for (const dimension of ['compensation', 'schedule', 'companyMarket']) if (['MISSING', 'UNKNOWN'].includes(upper(completeness[dimension]?.status))) nonCriticalUnknowns.push(dimension);
  if (upper(completeness.compensation?.status) === 'BELOW_THRESHOLD') critical.push('COMPENSATION_BELOW_THRESHOLD');
  if (Object.values(completeness).some(value => upper(value?.status) === 'CONFLICTING')) critical.push('EVIDENCE_CONTRADICTION');

  const blockers = [...new Set(critical)];
  if (blockers.length) {
    const conflict = blockers.some(reason => /CONFLICT|CONTRADICT|REJECT|BELOW_THRESHOLD/.test(reason));
    return { version: ACTION_READINESS_VERSION, state: conflict ? ACTION_READINESS_STATES.REVIEW_REQUIRED : ACTION_READINESS_STATES.RESEARCH_REQUIRED, actionReady: false, deepEvaluationReady: false, blockers, nonCriticalUnknowns };
  }
  if (!evaluation || evaluation.status !== 'VALID' || evaluation.recommendation !== 'APPLY') return { version: ACTION_READINESS_VERSION, state: ACTION_READINESS_STATES.DEEP_EVALUATION_READY, actionReady: false, deepEvaluationReady: true, blockers: [], nonCriticalUnknowns };
  if (!applicationPackage || applicationPackage.validationStatus !== 'VALID' || !['DRAFT', 'APPROVED'].includes(applicationPackage.status)) return { version: ACTION_READINESS_VERSION, state: ACTION_READINESS_STATES.PACKAGE_GENERATION_READY, actionReady: false, deepEvaluationReady: true, blockers: [], nonCriticalUnknowns };
  return { version: ACTION_READINESS_VERSION, state: ACTION_READINESS_STATES.ACTION_READY, actionReady: true, deepEvaluationReady: true, blockers: [], nonCriticalUnknowns };
}
