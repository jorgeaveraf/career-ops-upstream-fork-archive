import { hashStable } from '../acquisition/normalize.mjs';
import { ELIGIBILITY_RULES_VERSION, RANKING_RULES_VERSION } from './contracts.mjs';
import { evaluateEligibility } from './eligibility-engine.mjs';
import { rankOpportunity } from './ranking-engine.mjs';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function assessmentInputHash(job) {
  return hashStable(JSON.stringify(stable({
    observationId: job?.observationId || job?.id || '',
    title: job?.title || '', company: job?.company || '', location: job?.location || '',
    description: job?.description || '', salary: job?.salary || job?.compensation || job?.rawMetadata?.salary || null,
    employmentType: job?.employmentType || job?.rawMetadata?.employmentType || null,
    companyMarket: job?.companyMarket || job?.rawMetadata?.companyMarket || job?.rawMetadata?.company_market || null,
    remoteScope: job?.rawMetadata?.remoteScope || job?.rawMetadata?.remote_scope || null,
    eligibleCountries: job?.rawMetadata?.eligibleCountries || job?.rawMetadata?.eligible_countries || null,
    schedule: job?.rawMetadata?.schedule || job?.rawMetadata?.workingHours || null,
    fieldEvidence: job?.fieldEvidence || null, provenance: job?.provenance || null,
    discoveryStrategy: job?.rawMetadata?.discoveryStrategy || null,
    humanPreference: job?.humanPreference || null,
  })));
}

export function assessOpportunity(job, policy, {
  calculatedAt = new Date().toISOString(),
  eligibilityRulesVersion = ELIGIBILITY_RULES_VERSION,
  rankingRulesVersion = RANKING_RULES_VERSION,
} = {}) {
  const eligibility = evaluateEligibility(job, policy, { rulesVersion: eligibilityRulesVersion });
  const ranking = rankOpportunity(job, eligibility, policy, { rulesVersion: rankingRulesVersion });
  return {
    eligibility,
    candidateFit: ranking.candidateFit,
    opportunity: ranking.opportunity,
    finalPriority: ranking.finalPriority,
    compensation: eligibility.signals.compensation,
    eligibilityRulesVersion,
    rankingRulesVersion,
    unifiedCandidatePolicyVersion: policy.unifiedPolicyVersion,
    evidenceCompletenessVersion: policy.evidenceCompletenessVersion,
    researchNeedsVersion: policy.researchNeedsVersion,
    profileHash: policy.profileHash,
    inputHash: assessmentInputHash(job),
    calculatedAt: new Date(calculatedAt).toISOString(),
  };
}
