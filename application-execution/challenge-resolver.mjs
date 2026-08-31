const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export const APPLICATION_CHALLENGE = Object.freeze({
  NONE: 'NO_CHALLENGE',
  PASSIVE: 'PASSIVE_CHALLENGE',
  CAPTCHA: 'INTERACTIVE_CAPTCHA',
  MFA: 'MFA_REQUIRED',
  LOGIN: 'LOGIN_REAUTH_REQUIRED',
  SECURITY: 'SECURITY_CHALLENGE',
  TECHNICAL_TIMEOUT: 'TECHNICAL_CHALLENGE_TIMEOUT',
});

const MFA = /multi[- ]factor|two[- ]factor|2fa|authenticator app|security key|c[oó]digo de autenticaci[oó]n|verification code|6[- ]digit code/i;
const LOGIN = /sign in again|session expired|vuelve a iniciar sesi[oó]n|reauthenticate|inicia sesi[oó]n de nuevo/i;
const SECURITY = /unusual activity|security challenge|suspicious activity|confirm your identity|confirma tu identidad/i;
const CHALLENGE_TEXT = /captcha|recaptcha|hcaptcha|protected by recaptcha|protegido por recaptcha|verify you are human|no soy un robot|human verification/i;
const INTERACTIVE_TEXT = /check(?:box)?|select (?:all|the)|image puzzle|solve (?:the )?captcha|complete (?:the )?(?:captcha|challenge)|click (?:to )?verify|verify you are human|no soy un robot/i;
const BROKEN = /err_[a-z_]+|this site can.?t be reached|network error|page unavailable|blank frame|something went wrong/i;

function normalizedEvidence(input = {}) {
  const challenge = input.challenge || {};
  const body = clean(input.text || input.body);
  const frames = (Array.isArray(input.frames) ? input.frames : []).map(clean);
  const controls = Array.isArray(challenge.controls) ? challenge.controls : Array.isArray(input.challengeControls) ? input.challengeControls : [];
  const interactiveCount = Number(challenge.interactiveCount ?? input.interactiveChallengeCount ?? controls.length) || 0;
  const challengeFrameCount = Number(challenge.frameCount ?? input.challengeFrameCount ?? frames.filter(value => /captcha|recaptcha|hcaptcha|challenge/i.test(value)).length) || 0;
  return { ...input, challenge, body, frames, controls, interactiveCount, challengeFrameCount };
}

export function classifyApplicationChallenge(input = {}) {
  const evidence = normalizedEvidence(input);
  const haystack = clean(`${input.url || ''} ${input.title || ''} ${evidence.body} ${evidence.frames.join(' ')} ${evidence.controls.map(item => typeof item === 'string' ? item : `${item.type || ''} ${item.label || ''} ${item.role || ''}`).join(' ')}`);
  if (MFA.test(haystack)) return { outcome: APPLICATION_CHALLENGE.MFA, requiresHuman: true, evidence };
  if (LOGIN.test(haystack)) return { outcome: APPLICATION_CHALLENGE.LOGIN, requiresHuman: true, evidence };
  if (SECURITY.test(haystack) && !CHALLENGE_TEXT.test(haystack)) return { outcome: APPLICATION_CHALLENGE.SECURITY, requiresHuman: true, evidence };
  const challengePresent = Boolean(evidence.challenge.present || evidence.challengeFrameCount || CHALLENGE_TEXT.test(haystack));
  if (!challengePresent) return { outcome: APPLICATION_CHALLENGE.NONE, requiresHuman: false, evidence };
  const interactive = evidence.interactiveCount > 0
    || evidence.challenge.interactive === true
    || evidence.controls.some(item => INTERACTIVE_TEXT.test(clean(typeof item === 'string' ? item : `${item.type || ''} ${item.label || ''} ${item.role || ''}`)));
  if (interactive) return { outcome: APPLICATION_CHALLENGE.CAPTCHA, requiresHuman: true, evidence };
  const applicationReady = Boolean((input.next && !input.next.disabled) || (input.finalSubmit && !input.finalSubmit.disabled) || (input.accountAction && !input.accountAction.disabled) || Number(input.fields?.length || 0) > 0);
  if (applicationReady) return { outcome: APPLICATION_CHALLENGE.NONE, requiresHuman: false, passiveResolved: true, evidence };
  return { outcome: APPLICATION_CHALLENGE.PASSIVE, requiresHuman: false, evidence };
}

export function challengeProgressed(before = {}, after = {}) {
  const first = normalizedEvidence(before), next = normalizedEvidence(after);
  return clean(first.url) !== clean(next.url)
    || Boolean(!first.next && next.next)
    || Boolean(!first.finalSubmit && next.finalSubmit)
    || Boolean((first.next?.disabled ?? true) && next.next && !next.next.disabled)
    || Boolean((first.finalSubmit?.disabled ?? true) && next.finalSubmit && !next.finalSubmit.disabled)
    || Number(next.fields?.length || 0) > Number(first.fields?.length || 0)
    || (first.challenge?.present && !next.challenge?.present);
}

export async function resolveApplicationChallenge({ evidence, observe, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), waits = [5000, 5000, 5000], maxWaitMs = 20000 } = {}) {
  let current = evidence || {};
  let classification = classifyApplicationChallenge(current);
  if (classification.outcome !== APPLICATION_CHALLENGE.PASSIVE) return { ...classification, waitedMs: 0, observations: 1 };
  let waitedMs = 0, observations = 1, progressed = false;
  for (const requested of waits) {
    const delay = Math.max(0, Math.min(Number(requested) || 0, maxWaitMs - waitedMs));
    if (!delay) break;
    await wait(delay); waitedMs += delay;
    const next = await observe(); observations += 1;
    progressed ||= challengeProgressed(current, next);
    current = next; classification = classifyApplicationChallenge(current);
    if (classification.outcome !== APPLICATION_CHALLENGE.PASSIVE) return { ...classification, waitedMs, observations, progressed, evidence: normalizedEvidence(current) };
  }
  if (BROKEN.test(clean(`${current.title || ''} ${current.body || current.text || ''}`))) return { outcome: APPLICATION_CHALLENGE.TECHNICAL_TIMEOUT, requiresHuman: false, waitedMs, observations, progressed, reason: 'TECHNICAL_PAGE_FAILURE', evidence: normalizedEvidence(current) };
  return { outcome: APPLICATION_CHALLENGE.TECHNICAL_TIMEOUT, requiresHuman: false, waitedMs, observations, progressed, reason: 'PASSIVE_CHALLENGE_TIMEOUT', evidence: normalizedEvidence(current) };
}

export function challengeToSecurityCode(outcome) {
  return ({
    [APPLICATION_CHALLENGE.CAPTCHA]: 'CAPTCHA_REQUIRED',
    [APPLICATION_CHALLENGE.MFA]: 'MFA_REQUIRED',
    [APPLICATION_CHALLENGE.LOGIN]: 'LOGIN_REAUTH_REQUIRED',
    [APPLICATION_CHALLENGE.SECURITY]: 'SECURITY_CHALLENGE',
  })[outcome] || null;
}
