export const BROWSER_TASK_STATES = Object.freeze([
  'PLANNED', 'NAVIGATING', 'PAGE_CLASSIFIED', 'RESULTS_WAITING', 'RESULTS_READY',
  'SCROLLING', 'EXTRACTING', 'VALIDATING', 'COMPLETE',
]);

export const BROWSER_TASK_OUTCOMES = Object.freeze([
  'SUCCESS_RESULTS', 'SUCCESS_EMPTY', 'AUTH_REQUIRED', 'CHALLENGE', 'CAPTCHA',
  'WRONG_PAGE', 'SELECTOR_CHANGED', 'RESULTS_TIMEOUT', 'NAVIGATION_TIMEOUT',
  'EXTRACTION_FAILED', 'POLICY_BLOCKED',
]);

export const PAGE_CLASSIFICATIONS = Object.freeze([
  'EXPECTED_RESULTS', 'EMPTY_RESULTS', 'LOGIN', 'CHALLENGE', 'CAPTCHA', 'ERROR',
  'UNEXPECTED', 'UNKNOWN',
]);

const lower = value => String(value || '').toLowerCase();

export function classifyBrowserPage(snapshot = {}, runbook = {}) {
  const url = lower(snapshot.url); const title = lower(snapshot.title); const text = lower(snapshot.text);
  const all = `${url}\n${title}\n${text}`;
  if (/captcha|recaptcha|verify you are human|no soy un robot/.test(all)) return 'CAPTCHA';
  if (/checkpoint|security verification|unusual activity|challenge/.test(all)) return 'CHALLENGE';
  if (/\/login|\/signin|accounts\.google\.com\/signin|inicia sesi[oó]n|sign in to/.test(all)) return 'LOGIN';
  if (/something went wrong|server error|temporarily unavailable|p[aá]gina no disponible/.test(all)) return 'ERROR';
  if ((snapshot.records || []).length > 0 || Number(snapshot.cardCount) > 0) return 'EXPECTED_RESULTS';
  if (/no jobs found|no results|sin resultados|no encontramos empleos|0 empleos/.test(text)) return 'EMPTY_RESULTS';
  const expectedHosts = runbook.expectedHosts || [];
  if (expectedHosts.length && !expectedHosts.some(host => url.includes(host))) return 'UNEXPECTED';
  if (runbook.expectedUrlPattern && !new RegExp(runbook.expectedUrlPattern, 'i').test(snapshot.url || '')) return 'UNEXPECTED';
  return snapshot.domReady ? 'UNKNOWN' : 'UNKNOWN';
}

export function terminalOutcomeForClassification(classification) {
  return ({ LOGIN: 'AUTH_REQUIRED', CHALLENGE: 'CHALLENGE', CAPTCHA: 'CAPTCHA',
    ERROR: 'WRONG_PAGE', UNEXPECTED: 'WRONG_PAGE', EMPTY_RESULTS: 'SUCCESS_EMPTY' })[classification] || null;
}

export function semanticSuccess(outcome) {
  return outcome === 'SUCCESS_RESULTS' || outcome === 'SUCCESS_EMPTY';
}

export function validateTerminalOutcome(outcome) {
  if (!BROWSER_TASK_OUTCOMES.includes(outcome)) throw new TypeError(`invalid browser task outcome: ${outcome}`);
  return outcome;
}
