import { createUnifiedCandidatePolicy, loadUnifiedCandidatePolicy } from '../intelligence/unified-candidate-policy.mjs';

export function createCandidateSelectionPolicy(profile = {}, portals = {}, overrides = {}) {
  return createUnifiedCandidatePolicy(profile, portals, overrides);
}

export function loadCandidateSelectionPolicy({
  profilePath = process.env.CAREER_OPS_PROFILE || 'config/profile.yml',
  portalsPath = process.env.CAREER_OPS_PORTALS || 'portals.yml',
  overrides = {},
} = {}) {
  return loadUnifiedCandidatePolicy({ profilePath, portalsPath, overrides });
}
