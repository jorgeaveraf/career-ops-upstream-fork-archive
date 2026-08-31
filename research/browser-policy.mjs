export const BROWSER_RESEARCH_MODE = 'research_only';
export const BROWSER_RESEARCH_PROVENANCE_MODE = 'RESEARCH_ONLY';

export const ALLOWED_RESEARCH_ACTIONS = Object.freeze([
  'navigate', 'search', 'read', 'filter', 'scroll', 'open_result', 'extract_evidence',
]);

export const BLOCKED_EXTERNAL_ACTIONS = Object.freeze([
  'apply', 'submit', 'upload', 'send', 'message', 'connect', 'accept_connection',
  'post', 'comment', 'modify_profile', 'publish', 'react', 'follow',
  'join', 'request_to_join', 'leave_group', 'like', 'share', 'friend_request',
]);

const normalizeAction = action => String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

export class BrowserPolicyError extends Error {
  constructor(action) {
    super(`Browser Research action is not allowed by research_only policy: ${action || 'UNKNOWN'}`);
    this.name = 'BrowserPolicyError'; this.code = 'BROWSER_ACTION_DENIED'; this.action = action || 'UNKNOWN';
  }
}

export function assertResearchActionAllowed(action) {
  const normalized = normalizeAction(action);
  if (!ALLOWED_RESEARCH_ACTIONS.includes(normalized)) throw new BrowserPolicyError(normalized);
  return normalized;
}

export function browserPolicySummary() {
  return { mode: BROWSER_RESEARCH_MODE, allowed: [...ALLOWED_RESEARCH_ACTIONS], blocked: [...BLOCKED_EXTERNAL_ACTIONS] };
}
