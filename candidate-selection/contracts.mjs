export const CANDIDATE_SELECTION_RULES_VERSION = '2';

export const FILTER_OUTCOMES = Object.freeze(['PASS', 'REJECT', 'UNKNOWN']);
export const ACTIVE_CANDIDATE_STATES = Object.freeze([
  'ACTIVE', 'CARRYOVER', 'EXPIRED', 'DISCARDED', 'ACTED', 'SUPERSEDED',
]);
export const SEMANTIC_FUNNEL_STAGES = Object.freeze([
  'RAW_DISCOVERED', 'NORMALIZED', 'UNIQUE_JOBS',
  'FILTER_PASS', 'FILTER_REJECT', 'FILTER_UNKNOWN', 'ACTIVE_SET',
  'ELIGIBILITY_ELIGIBLE', 'ELIGIBILITY_INELIGIBLE', 'ELIGIBILITY_UNKNOWN',
  'RANKED', 'TOP_10', 'DEEP_EVALUATED', 'PACKAGE_READY',
]);

export function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}
