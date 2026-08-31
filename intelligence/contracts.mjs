export const ELIGIBILITY_RULES_VERSION = '4';
export const RANKING_RULES_VERSION = '4';

export const ELIGIBILITY_STATUSES = Object.freeze(['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN']);
export const ASSESSMENT_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const COMPENSATION_STATUSES = Object.freeze(['KNOWN_ACCEPTABLE', 'BELOW_THRESHOLD', 'UNKNOWN', 'NOT_COMPARABLE']);
export const RESEARCH_NEED_TYPES = Object.freeze([
  'FETCH_FULL_DESCRIPTION', 'CONFIRM_MEXICO_ELIGIBILITY', 'CONFIRM_REMOTE_SCOPE',
  'CONFIRM_EMPLOYMENT_MODEL', 'CONFIRM_COMPENSATION', 'CONFIRM_COMPANY_MARKET',
  'CONFIRM_SCHEDULE', 'RESOLVE_LOCATION_CONFLICT', 'CONFIRM_POSTING_IS_REAL',
]);
export const RESEARCH_NEED_STATES = Object.freeze(['OPEN', 'RESOLVED', 'OBSOLETE', 'BLOCKED']);
export const PRIORITY_DECISIONS = Object.freeze(['SHORTLIST', 'CONSIDER', 'REVIEW', 'REJECT']);

/**
 * @typedef {object} RuleEvidence
 * @property {string} ruleId
 * @property {string} field
 * @property {unknown} value
 * @property {string} source
 * @property {'positive'|'negative'|'neutral'} effect
 */

/**
 * @typedef {object} EligibilityResult
 * @property {'ELIGIBLE'|'INELIGIBLE'|'UNKNOWN'} status
 * @property {number} eligibilityScore
 * @property {string[]} reasons
 * @property {RuleEvidence[]} evidence
 * @property {'high'|'medium'|'low'} confidence
 * @property {string[]} rulesApplied
 * @property {string} rulesVersion
 */

/**
 * @typedef {object} RankingResult
 * @property {{score:number,band:string,reasons:string[]}} candidateFit
 * @property {{score:number,band:string,components:object,reasons:string[]}} opportunity
 * @property {{score:number,decision:string,reasons:string[]}} finalPriority
 * @property {string} rulesVersion
 */

export function scoreBand(score) {
  if (score >= 75) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

export function boundedScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}
