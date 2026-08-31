import { canonicalFacebookUrl } from './extraction.mjs';

export class FacebookJoinPolicyError extends Error {
  constructor(message) { super(message); this.name = 'FacebookJoinPolicyError'; this.code = 'FACEBOOK_JOIN_POLICY_BLOCKED'; }
}

export function assertExactCommunityJoinAuthorization({ community, authorization } = {}) {
  if (!community?.id || !community?.canonicalUrl || !authorization?.actionId) throw new FacebookJoinPolicyError('community and persisted authorization are required');
  if (authorization.decision !== 'WANT_TO_JOIN') throw new FacebookJoinPolicyError('only WANT_TO_JOIN authorizes a community join');
  if (community.suppressedAt) throw new FacebookJoinPolicyError('suppressed communities cannot be joined');
  const expected = canonicalFacebookUrl(community.canonicalUrl);
  const authorized = canonicalFacebookUrl(authorization.url);
  if (!expected || authorized !== expected) throw new FacebookJoinPolicyError('authorization does not match the exact community URL');
  return Object.freeze({ communityId: community.id, actionId: authorization.actionId, canonicalUrl: expected, authorizedAt: authorization.authorizedAt });
}

export function assertObservedCommunityIdentity(authorization, observedUrl) {
  const observed = canonicalFacebookUrl(observedUrl);
  if (!observed || observed !== authorization.canonicalUrl) throw new FacebookJoinPolicyError('observed page does not match the authorized community URL');
  return observed;
}
