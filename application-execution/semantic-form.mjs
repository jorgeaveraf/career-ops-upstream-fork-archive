import { resolveApplicationQuestion } from './question-resolver.mjs';
import { challengeToSecurityCode, classifyApplicationChallenge } from './challenge-resolver.mjs';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const normalizeFieldKey = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const SECURITY_PATTERNS = Object.freeze([
  ['MFA_REQUIRED', /multi[- ]factor|two[- ]factor|2fa|authenticator app|security key|c[oó]digo de autenticaci[oó]n/i],
  ['LOGIN_REAUTH_REQUIRED', /sign in again|session expired|vuelve a iniciar sesi[oó]n|reauthenticate/i],
  ['SECURITY_CHALLENGE', /unusual activity|security challenge|security check|suspicious activity/i],
  ['PLATFORM_RESTRICTION', /applications? (?:are )?not accepted|cannot apply|not available in your (?:country|region)|application limit/i],
]);

export function classifySecurityBoundary({ text = '', body = '', frames = [], url = '', challenge = {}, challengeControls = [] } = {}) {
  const haystack = `${url} ${text || body} ${(frames || []).join(' ')}`;
  for (const [code, pattern] of SECURITY_PATTERNS) if (pattern.test(haystack)) return code;
  return challengeToSecurityCode(classifyApplicationChallenge({ text: text || body, frames, url, challenge, challengeControls }).outcome);
}

export function semanticMeaning(field = {}) {
  const label = clean(`${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`).toLowerCase();
  if (/first.?name|given.?name/.test(label)) return 'candidate.first_name';
  if (/last.?name|family.?name|surname/.test(label)) return 'candidate.last_name';
  if (/full.?name|candidate.?name|your name/.test(label) || clean(field.label).toLowerCase() === 'name') return 'candidate.full_name';
  if (/e-?mail/.test(label)) return 'candidate.application_email';
  if (/phone|mobile|telephone|tel[eé]fono/.test(label)) return 'candidate.phone';
  if (/linkedin/.test(label)) return 'candidate.linkedin';
  if (/portfolio|website|github/.test(label)) return 'candidate.portfolio';
  if (/resume|r[eé]sum[eé]|curriculum|cv\b/.test(label)) return 'package.resume';
  if (/cover.?letter|carta de presentaci[oó]n/.test(label)) return 'package.cover_letter';
  if (/salary|compensation|sueldo|salario/.test(label)) return 'candidate.salary_expectation';
  if (/notice period|preaviso/.test(label)) return 'candidate.notice_period';
  if (/start date|available to start|fecha de inicio/.test(label)) return 'candidate.start_date';
  if (/sponsor/.test(label)) return 'candidate.sponsorship';
  if (/authorized to work|work authorization|autorizad[oa].*trabajar/.test(label)) return 'candidate.work_authorization';
  if (/address|city|location|ubicaci[oó]n|domicilio/.test(label)) return 'candidate.location';
  if (/password|contrase[nñ]a/.test(label)) return 'account.password';
  return `application.${normalizeFieldKey(field.label || field.name || 'unknown')}`;
}

function exactPlanAnswer(field, plan) {
  const key = normalizeFieldKey(field.label || field.name);
  const answers = plan?.resolvedApplicationQuestions || plan?.resolvedAnswers || [];
  const item = Array.isArray(answers) ? answers.find(value => normalizeFieldKey(value.field || value.question || value.label) === key) : answers[key];
  if (item == null) return null;
  const value = typeof item === 'object' && Object.hasOwn(item, 'answer') ? item.answer : item;
  return { value, source: 'EXACT_APPLICATION_PLAN', confidence: 'HIGH' };
}

function humanAnswer(field, answers, scope) {
  const key = normalizeFieldKey(field.label || field.name);
  const item = (answers || []).find(value => value.scope === scope && (value.normalizedField === key || normalizeFieldKey(value.question) === key));
  return item ? { value: item.answer, source: scope === 'GLOBAL' ? 'VERIFIED_REUSABLE_ANSWER' : 'EXACT_HUMAN_ANSWER', confidence: 'HIGH' } : null;
}

export function resolveSemanticField(field, { candidateAnswers = {}, plan = {}, humanAnswers = [], answerMemory = [], artifactManifest = {}, jobId = null, now = new Date() } = {}) {
  const meaning = semanticMeaning(field);
  if (field.type === 'file') {
    const artifactName = meaning === 'package.cover_letter' ? 'cover-letter.pdf' : 'resume.pdf';
    const artifact = artifactManifest?.files?.[artifactName];
    if (artifact?.path && artifact?.hash) return { ...field, meaning, resolved: true, canonicalAnswer: true, artifactName, value: artifact.path, source: 'EXACT_PACKAGE_ARTIFACT', confidence: 'HIGH' };
    return { ...field, meaning, resolved: false, canonicalAnswer: false, source: null, confidence: 'NONE' };
  }
  return resolveApplicationQuestion(field, { candidateAnswers, plan, humanAnswers, answerMemory, jobId, now });
}

export function describeSemanticFields(fields = [], context = {}) {
  return fields.map(field => resolveSemanticField(field, context));
}

export function isLegalAttestation(field = {}) {
  const text = clean(`${field.label || ''} ${field.name || ''} ${field.context || ''}`);
  return /certify|attest|declare under|electronic signature|legal acknowledgement|juramento|declaro|firma electr[oó]nica/i.test(text);
}
