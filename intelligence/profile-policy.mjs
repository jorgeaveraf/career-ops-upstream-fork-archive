import { createUnifiedCandidatePolicy, loadUnifiedCandidatePolicy } from './unified-candidate-policy.mjs';

export function createOpportunityPolicy(profile = {}, portals = {}) {
  return createUnifiedCandidatePolicy(profile, portals);
}

export function loadOpportunityPolicy({
  profilePath = process.env.CAREER_OPS_PROFILE || 'config/profile.yml',
  portalsPath = process.env.CAREER_OPS_PORTALS || 'portals.yml',
} = {}) {
  return loadUnifiedCandidatePolicy({ profilePath, portalsPath });
}
