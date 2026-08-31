export const HUMAN_DECISION_LIFECYCLE_VERSION = '2A.1';
export const REJECTION_INTELLIGENCE_VERSION = '1';

export const CANONICAL_HUMAN_DECISIONS = Object.freeze(['NO_ACTION', 'REJECT', 'HOLD', 'NEXT_STAGE']);
export const LEGACY_HUMAN_DECISIONS = Object.freeze(['REVIEW', 'APPROVE']);
export const REJECTION_REASONS = Object.freeze([
  'ROLE_NOT_RELEVANT', 'COMPANY_NOT_INTERESTING', 'COMPENSATION', 'GEOGRAPHY',
  'EMPLOYMENT_MODEL', 'SCHEDULE', 'SENIORITY', 'STACK_MISMATCH',
  'LANGUAGE_REQUIREMENT', 'POOL_OR_MARKETPLACE', 'LOW_QUALITY_POSTING', 'OTHER',
]);
export const ENRICHMENT_STATUSES = Object.freeze(['PENDING', 'IN_PROGRESS', 'READY', 'FAILED', 'CANCELLED']);

export function canonicalHumanDecision(value) {
  const normalized = String(value || 'NO_ACTION').trim().toUpperCase();
  if (normalized === 'REVIEW') return 'HOLD';
  if (normalized === 'APPROVE') return 'NEXT_STAGE';
  return CANONICAL_HUMAN_DECISIONS.includes(normalized) ? normalized : 'NO_ACTION';
}

export function decisionOutcome(decision, enrichmentStatus = null) {
  if (canonicalHumanDecision(decision) === 'REJECT') return 'REJECTED';
  if (canonicalHumanDecision(decision) === 'HOLD') return 'HELD';
  if (canonicalHumanDecision(decision) === 'NEXT_STAGE') return enrichmentStatus === 'PENDING' ? 'ENRICHMENT_QUEUED' : `ENRICHMENT_${enrichmentStatus || 'QUEUED'}`;
  return 'NO_ACTION';
}
