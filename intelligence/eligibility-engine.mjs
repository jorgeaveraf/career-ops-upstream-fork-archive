import { ELIGIBILITY_RULES_VERSION } from './contracts.mjs';
import { buildResearchNeeds, normalizeEvidenceText, resolveCandidateEvidence } from './evidence-resolver.mjs';
import { minimumWeeklyHours } from './signals.mjs';
import { normalizeCompanyPolicyIdentity } from './unified-candidate-policy.mjs';

function evidence(ruleId, field, value, source, effect, confidence = 'high') {
  return { ruleId, field, value, source, effect, confidence };
}

function matchesPhrase(haystack, values) {
  return (values || []).find(value => {
    const phrase = normalizeEvidenceText(value);
    return phrase && (phrase.length <= 3 ? new RegExp(`\\b${phrase}\\b`).test(haystack) : haystack.includes(phrase));
  }) || '';
}

export function evaluateEligibility(job, policy, { rulesVersion = ELIGIBILITY_RULES_VERSION } = {}) {
  const resolved = resolveCandidateEvidence(job, policy);
  const title = normalizeEvidenceText(job?.title);
  const combined = normalizeEvidenceText([job?.location, job?.description].join(' '));
  const reasons = [];
  const evidenceFound = [];
  const hardStops = [];
  const rulesApplied = [];
  const hardStop = (ruleId, reason, item) => {
    rulesApplied.push(ruleId); hardStops.push(ruleId); reasons.push(reason); evidenceFound.push(item);
  };

  const excluded = matchesPhrase(title, policy?.excludedSeniority);
  if (excluded) hardStop('seniority.excluded', `Title matches excluded seniority: ${excluded}.`, evidence('seniority.excluded', 'title', excluded, 'unified_candidate_policy', 'negative'));
  const company = normalizeCompanyPolicyIdentity(job?.company);
  const companyBlock = (policy?.hardRejectCompanies || []).find(value => normalizeCompanyPolicyIdentity(value) === company);
  if (companyBlock) hardStop('company.hard_reject', `Company is explicitly excluded by policy: ${companyBlock}.`, evidence('company.hard_reject', 'company', companyBlock, 'unified_candidate_policy', 'negative'));
  if (resolved.posting.status === 'CONFIRMED_POOL_ONLY') {
    hardStop('posting.pool_only', 'The observation is a confirmed talent pool, not a concrete opportunity.', resolved.posting.evidence[0]);
  } else if (resolved.posting.status === 'MARKETPLACE_SIGNAL') {
    rulesApplied.push('posting.marketplace_warning'); reasons.push('A marketplace signal was found, but the posting still appears to describe a concrete role.');
    evidenceFound.push(...resolved.posting.evidence);
  }
  if (policy?.remoteOnly && /\b(on site|onsite|hybrid)\b/.test(combined)) {
    hardStop('location.remote_only', 'Role explicitly requires excluded on-site or hybrid attendance.', evidence('location.remote_only', 'location/description', job?.location || '', 'job_posting', 'negative'));
  }
  if (resolved.schedule.status === 'CONFLICTING') hardStop('schedule.hard_stop', 'Schedule explicitly conflicts with candidate policy.', resolved.schedule.evidence[0]);

  const hours = minimumWeeklyHours(job);
  if (hours != null && ['contract', 'fractional', 'part_time'].includes(resolved.employment.model) && hours < 20) {
    hardStop('employment.minimum_commitment', `Only ${hours} hours/week are stated; policy requires at least 20.`, evidence('employment.minimum_commitment', 'description', hours, 'unified_candidate_policy + job_posting', 'negative'));
  }
  if (resolved.geography.status === 'EXCLUDED') {
    hardStop('location.country_lock', 'An explicit foreign residency restriction excludes a Mexico-based candidate.', resolved.geography.negative[0]);
  } else if (resolved.geography.status === 'CONFLICTING') {
    rulesApplied.push('location.conflicting_scope'); reasons.push('Location evidence is contradictory; explicit resolution is required.'); evidenceFound.push(...resolved.geography.evidence);
  } else if (resolved.geography.status === 'SUPPORTED') {
    rulesApplied.push('location.inclusive'); reasons.push('Location evidence explicitly supports a Mexico-based candidate.'); evidenceFound.push(...resolved.geography.evidence);
  } else if (resolved.geography.status === 'AMBIGUOUS') {
    rulesApplied.push('location.remote_ambiguous'); reasons.push('Remote is stated without an eligible country scope.'); evidenceFound.push(...resolved.geography.evidence);
  } else {
    rulesApplied.push('location.unproven'); reasons.push('No explicit evidence proves that the role is viable from Mexico.');
  }
  if (resolved.employment.model !== 'unknown') {
    rulesApplied.push(`employment.${resolved.employment.model}`); reasons.push(`Employment model detected: ${resolved.employment.model.replace('_', '-')}.`); evidenceFound.push(...resolved.employment.evidence);
  }
  rulesApplied.push(`compensation.${resolved.compensation.status.toLowerCase()}`);
  if (resolved.compensation.status === 'BELOW_THRESHOLD') {
    hardStop('compensation.below_threshold', 'Comparable compensation is below the configured company-market threshold.', resolved.compensation.evidence[0]);
  } else if (resolved.compensation.status === 'KNOWN_ACCEPTABLE') reasons.push('Comparable compensation meets the configured company-market threshold.');
  else if (resolved.compensation.status === 'NOT_COMPARABLE') reasons.push('Compensation is present but cannot be compared without guessing currency, period, basis, or company market.');
  else reasons.push('Compensation is not stated; this does not negate proven geographic eligibility.');

  let status;
  let confidence;
  if (hardStops.length) { status = 'INELIGIBLE'; confidence = 'high'; }
  else if (resolved.geography.status === 'SUPPORTED') { status = 'ELIGIBLE'; confidence = 'high'; }
  else { status = 'UNKNOWN'; confidence = resolved.geography.status === 'CONFLICTING' ? 'medium' : 'low'; }
  const researchNeeds = buildResearchNeeds(job, resolved);
  const dimensions = Object.entries(resolved.evidenceCompleteness).filter(([, value]) => value && typeof value === 'object');
  const incomplete = value => ['MISSING', 'UNKNOWN', 'AMBIGUOUS', 'CONFLICTING', 'NOT_COMPARABLE'].includes(value.status);
  return {
    status, eligibilityScore: status === 'ELIGIBLE' ? 100 : status === 'INELIGIBLE' ? 0 : 50,
    reasons: [...new Set(reasons)], evidence: evidenceFound.filter(Boolean), confidence,
    rulesApplied: [...new Set(rulesApplied)], rulesVersion,
    signals: { employmentModel: resolved.employment.model, ...resolved }, researchNeeds,
    explainability: {
      known: dimensions.filter(([, value]) => !incomplete(value)).map(([dimension, value]) => ({ dimension, status: value.status })),
      unknown: dimensions.filter(([, value]) => incomplete(value)).map(([dimension, value]) => ({ dimension, status: value.status })),
      blockers: hardStops, researchNeeded: researchNeeds.map(item => item.type),
    },
  };
}
