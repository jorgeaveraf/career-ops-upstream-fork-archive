export const FACEBOOK_CAPABILITY_VERSION = '2C.2';
export const FACEBOOK_CAPABILITIES = Object.freeze({
  'facebook.community_discovery': 'SUPPORTED',
  'facebook.group_monitoring': 'SUPPORTED',
  'facebook.post_opportunity_extraction': 'SUPPORTED',
  'facebook.join': 'SUPPORTED_WITH_EXACT_HUMAN_AUTHORIZATION',
  'facebook.messaging': 'UNSUPPORTED',
  'facebook.apply': 'UNSUPPORTED',
});
export const COMMUNITY_RECOMMENDATIONS = Object.freeze(['RECOMMENDED','CONSIDER','LOW_VALUE','REJECTED','UNKNOWN']);
export const COMMUNITY_MEMBERSHIP_STATES = Object.freeze(['DISCOVERED','RECOMMENDED','JOIN_REQUIRED','JOINED_CONFIRMED','MONITORING','SKIPPED','REJECTED','LEFT','BLOCKED','UNKNOWN']);
export const COMMUNITY_HUMAN_DECISIONS = Object.freeze(['NO_ACTION','WANT_TO_JOIN','JOINED','SKIP','REJECT']);
export const FACEBOOK_PAGE_CLASSIFICATIONS = Object.freeze(['SEARCH_RESULTS','GROUP_PAGE','GROUP_PRIVATE_NOT_MEMBER','GROUP_PRIVATE_MEMBER','POST_PAGE','LOGIN_PAGE','CHALLENGE','CAPTCHA','UNEXPECTED_PAGE']);
export const FACEBOOK_OUTCOMES = Object.freeze(['SUCCESS_RESULTS','SUCCESS_EMPTY','AUTH_REQUIRED','CHALLENGE','CAPTCHA','WRONG_PAGE','SELECTOR_CHANGED','RESULTS_TIMEOUT','EXTRACTION_FAILED','POLICY_BLOCKED']);
export const FACEBOOK_JOIN_OUTCOMES = Object.freeze(['JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','ALREADY_JOINED','JOIN_FAILED','CHALLENGE','AUTH_REQUIRED','POLICY_BLOCKED']);
export const FACEBOOK_DISCOVERY_BUDGET = Object.freeze({ maxQueries: 10, maxCandidates: 30, maxGroupsOpened: 20, maxScrollPasses: 3, stablePasses: 2, maxDurationMs: 12 * 60_000 });
export const FACEBOOK_MONITOR_BUDGET = Object.freeze({ freshnessDays: 30, maxScrollPasses: 3, maxPosts: 25, maxDurationPerGroupMs: 90_000, maxGroups: 8, stablePasses: 2 });
