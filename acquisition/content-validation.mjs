import { CONTENT_STATUSES } from './contracts.mjs';

const CAPTCHA_PATTERNS = [
  /\bcaptcha\b/i,
  /verify (?:that )?you(?:'re| are) human/i,
  /robot verification/i,
];

const CHALLENGE_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /performing security verification/i,
  /enable javascript and cookies/i,
];

const BLOCKED_PATTERNS = [
  /access denied/i,
  /request blocked/i,
  /temporarily blocked/i,
  /unusual traffic/i,
];

const LOGIN_PATTERNS = [
  /(?:sign|log) in (?:to|before) (?:continue|view|access)/i,
  /authentication required/i,
  /please log in/i,
];

const NOT_JOB_PATTERNS = [
  /(?:job|position|vacancy) (?:was |is )?(?:not found|no longer available|closed|expired)/i,
  /we (?:could not|couldn't) find (?:that|this) (?:job|position)/i,
  /no jobs? found/i,
];

/**
 * Classify acquired text independently from its HTTP status. This is a generic
 * foundation, not a production page parser: adapters may add source-specific
 * schema validators and return SCHEMA_CHANGED.
 *
 * @param {{httpStatus?: number, text?: string, schemaValid?: boolean, expectedJob?: boolean}} input
 * @returns {{status: typeof CONTENT_STATUSES[number], reason: string}}
 */
export function validateContent({ httpStatus, text, schemaValid, expectedJob = false } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (httpStatus === 404 || httpStatus === 410) return { status: 'NOT_FOUND', reason: `http_${httpStatus}` };
  if (httpStatus === 401) return { status: 'LOGIN_REQUIRED', reason: 'http_401' };
  if (httpStatus === 403) return { status: 'BLOCKED', reason: 'http_403' };
  if (!body) return { status: 'EMPTY_CONTENT', reason: 'empty_body' };
  if (CAPTCHA_PATTERNS.some(pattern => pattern.test(body))) {
    return { status: 'CAPTCHA', reason: 'captcha_marker' };
  }
  if (CHALLENGE_PATTERNS.some(pattern => pattern.test(body))) {
    return { status: 'CHALLENGE', reason: 'challenge_marker' };
  }
  if (BLOCKED_PATTERNS.some(pattern => pattern.test(body))) {
    return { status: 'BLOCKED', reason: 'blocked_marker' };
  }
  if (LOGIN_PATTERNS.some(pattern => pattern.test(body))) {
    return { status: 'LOGIN_REQUIRED', reason: 'login_marker' };
  }
  if (expectedJob && NOT_JOB_PATTERNS.some(pattern => pattern.test(body))) {
    return { status: 'NOT_JOB_CONTENT', reason: 'not_job_marker' };
  }
  if (schemaValid === false) return { status: 'SCHEMA_CHANGED', reason: 'schema_validation_failed' };
  return { status: 'VALID', reason: 'content_valid' };
}
