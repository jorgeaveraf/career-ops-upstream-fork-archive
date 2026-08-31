import { answerForField } from './canonical-answers.mjs';
import { deriveExperienceDuration } from './experience-duration.mjs';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const key = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const text = field => clean(`${field.label || ''} ${field.name || ''} ${field.context || ''}`).toLowerCase();
const coreText = field => clean(`${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`).toLowerCase();

export const QUESTION_RESOLUTION = Object.freeze({
  EXACT: 'EXACT_FACT', DERIVED: 'DERIVED_FACT', POLICY: 'POLICY_ANSWER', GENERATED: 'GENERATED_ANSWER', PREVIOUS: 'PREVIOUS_VERIFIED_ANSWER', HUMAN: 'HUMAN_REQUIRED', SENSITIVE: 'SENSITIVE_EXTERNAL_ACTION',
});

export function normalizeQuestionSemanticKey(field = {}) {
  const value = text(field), core=coreText(field);
  if (/passport|citizenship|nationality|ciudadan[ií]a|nacionalidad/.test(core)) return 'candidate.citizenship_or_passport';
  if (/first.?name|given.?name/.test(core)) return 'candidate.first_name';
  if (/last.?name|family.?name|surname/.test(core)) return 'candidate.last_name';
  if (/full.?name|candidate.?name|your name/.test(core) || clean(field.label).toLowerCase() === 'name') return 'candidate.full_name';
  if (/e-?mail/.test(core)) return 'candidate.application_email';
  if (/phone|mobile|telephone|tel[eé]fono/.test(core)) return 'candidate.phone';
  if (/linkedin/.test(core)) return 'candidate.linkedin';
  if (/portfolio|website|github/.test(core)) return 'candidate.portfolio';
  if (/address|city|location|ubicaci[oó]n|domicilio/.test(core)) return 'candidate.location';
  if (/summary|professional profile|about yourself|tell us about yourself|resumen profesional/.test(value)) return 'summary.professional';
  if (/english/.test(value) && /fluent|fluency|professional|level|proficiency/.test(value)) return 'language.english.professional_fluent';
  if (/python/.test(value) && /years?|experience|experiencia/.test(value)) return 'experience.python.years';
  if (/(ai engineer|artificial intelligence engineer|ingenier[oa].*(?:ia|inteligencia artificial))/.test(value) && /years?|experience|experiencia/.test(value)) return 'experience.ai_engineering.years';
  if (/bedrock/.test(value) && /years?|experience|experiencia/.test(value)) return 'experience.aws_bedrock.years';
  if (/bedrock/.test(value)) return 'experience.aws_bedrock.capabilities';
  if (/salary|compensation|sueldo|salario|expectation/.test(value)) {
    const employment = /contractor|contract|contratista/.test(value) ? 'contractor' : /employee|full.?time|empleado/.test(value) ? 'employee' : 'unspecified';
    const period = /month|mensual|mes/.test(value) ? 'monthly' : /annual|year|anual/.test(value) ? 'annual' : /hour|hora/.test(value) ? 'hourly' : 'unspecified';
    const currency = /mxn|peso/.test(value) ? 'mxn' : /usd|dollar|dólar/.test(value) ? 'usd' : 'unspecified';
    return `compensation.${employment}.${period}_${currency}`;
  }
  if (/authorized to work|work authorization|autorizad[oa].*trabajar/.test(value)) return /mexico|méxico/.test(value) ? 'work_auth.mexico' : 'work_auth.other';
  if (/sponsor/.test(value)) return 'sponsorship.required';
  if (/certify|attest|declare under|electronic signature|legal acknowledgement|juramento|declaro|firma electr[oó]nica/i.test(value)) return 'legal.attestation';
  return `application.${key(field.semantic_hint || field.label || field.name || 'unknown')}`;
}

const resolution = (field, semanticKey, resolutionType, value, { confidence = 'HIGH', evidenceRefs = [], scope = 'GLOBAL', reusable = true, source = resolutionType } = {}) => ({ ...field, meaning: semanticKey, semanticKey, resolved: true, canonicalAnswer: true, value, resolutionType, resolution_type: resolutionType, confidence, evidenceRefs, evidence_refs: evidenceRefs, scope, reusable, source });

function exactPlan(field, semanticKey, plan = {}) {
  const answers = plan.resolvedApplicationQuestions || plan.resolvedAnswers || [];
  const item = Array.isArray(answers) ? answers.find(value => normalizeQuestionSemanticKey({ label: value.field || value.question || value.label }) === semanticKey || key(value.field || value.question || value.label) === key(field.label || field.name)) : answers[semanticKey] ?? answers[key(field.label || field.name)];
  if (item == null) return null;
  return typeof item === 'object' && Object.hasOwn(item, 'answer') ? item.answer : item;
}

function previousAnswer(semanticKey, answers = [], memory = [], jobId = null) {
  const combined = [...answers.map(item => ({ semanticKey: item.normalizedField, answer: item.answer, scope: item.scope, jobId: item.jobId, updatedAt: item.updatedAt, source: item.humanSource })), ...memory];
  return combined.filter(item => (item.semanticKey === semanticKey || item.normalizedField === semanticKey || normalizeQuestionSemanticKey({ label: String(item.semanticKey || item.normalizedField || '').replaceAll('_', ' ') }) === semanticKey) && item.answer != null && (item.scope === 'GLOBAL' || item.scope === 'REUSABLE_GLOBAL' || (item.scope === 'JOB' && (!jobId || item.jobId === jobId))) && item.reusable !== false).sort((a, b) => String(b.updatedAt || b.resolvedAt || '').localeCompare(String(a.updatedAt || a.resolvedAt || '')))[0] || null;
}

function experienceSubject(semanticKey) {
  if (semanticKey === 'experience.python.years') return 'Python';
  if (semanticKey === 'experience.ai_engineering.years') return 'AI Engineer';
  if (semanticKey === 'experience.aws_bedrock.years') return 'AWS Bedrock';
  return null;
}

function policyAnswer(field, semanticKey, candidate = {}) {
  if (semanticKey === 'language.english.professional_fluent') {
    const level = candidate.language?.english || candidate.englishProfessionalLevel;
    if (!level) return null;
    const supported = /^(?:c1|c2|professional|fluent|native)/i.test(clean(typeof level === 'object' ? level.proficiency || level.level : level));
    if (/yes|no|true|false|s[ií]|fluent|speak/.test(text(field))) return { value: supported ? 'Yes' : 'No', evidenceRefs: ['config/profile.yml#language'], source: 'CANDIDATE_LANGUAGE_POLICY' };
    return { value: clean(typeof level === 'object' ? level.proficiency || level.level : level), evidenceRefs: ['config/profile.yml#language'], source: 'CANDIDATE_LANGUAGE_POLICY' };
  }
  if (semanticKey.startsWith('compensation.')) {
    const [, employment, periodCurrency] = semanticKey.split('.'); const [period, currency] = periodCurrency.split('_');
    const alias = employment === 'contractor' ? 'contract' : employment === 'employee' ? 'full_time' : employment;
    const policy = candidate.compensation?.byEmploymentType?.[alias];
    if (!policy) return null;
    const policyPeriod = clean(policy.period).replace(/ly$/, '');
    if (currency !== 'unspecified' && clean(policy.currency).toLowerCase() !== currency) return null;
    if (period !== 'unspecified' && policyPeriod !== period.replace(/ly$/, '')) return null;
    return { value: policy.desired ?? policy.minimum, evidenceRefs: [`config/profile.yml#compensation.by_employment_type.${alias}`], source: 'SCOPED_COMPENSATION_POLICY', scope: `COMPENSATION:${alias}:${policy.period}:${policy.currency}` };
  }
  return null;
}

function generatedAnswer(field, semanticKey, candidate = {}) {
  if (semanticKey !== 'summary.professional' || !candidate.professionalSummary) return null;
  const limit = Number(field.maxLength || field.max_length) || 0;
  let value = clean(candidate.professionalSummary).split(' ').slice(0, 120).join(' ');
  if (limit && value.length > limit) value = value.slice(0, Math.max(0, limit - 1)).trimEnd();
  return { value, evidenceRefs: ['cv.md#AI Systems Engineer'], source: 'EVIDENCE_BACKED_TEMPLATE', confidence: 'HIGH' };
}

export function resolveApplicationQuestion(field = {}, context = {}) {
  const semanticKey = normalizeQuestionSemanticKey(field);
  // Residence and work-location evidence must never be promoted into a
  // citizenship/passport claim. Those are distinct human facts, but an answer
  // explicitly supplied and verified by the candidate may be reused.
  if (semanticKey === 'candidate.citizenship_or_passport') {
    const verified = previousAnswer(semanticKey, context.humanAnswers, context.answerMemory, context.jobId);
    if (verified) return resolution(field, semanticKey, QUESTION_RESOLUTION.PREVIOUS, verified.answer, { evidenceRefs: [verified.id || verified.source || 'VERIFIED_ANSWER'], scope: verified.scope, reusable: true, source: 'VERIFIED_ANSWER_MEMORY' });
    return { ...field, meaning: semanticKey, semanticKey, resolved: false, canonicalAnswer: false, resolutionType: QUESTION_RESOLUTION.HUMAN, resolution_type: QUESTION_RESOLUTION.HUMAN, confidence: 'NONE', evidenceRefs: [], evidence_refs: [], scope: 'JOB', reusable: false, source: null };
  }
  if (semanticKey === 'legal.attestation') return { ...field, meaning: semanticKey, semanticKey, resolved: false, canonicalAnswer: false, resolutionType: QUESTION_RESOLUTION.HUMAN, confidence: 'NONE', evidenceRefs: [], scope: 'JOB', reusable: false };
  if (/password|verification code|authenticator|one.?time code|otp/i.test(text(field))) return { ...field, meaning: semanticKey, semanticKey, resolved: false, canonicalAnswer: false, resolutionType: QUESTION_RESOLUTION.SENSITIVE, confidence: 'NONE', evidenceRefs: [], scope: 'JOB', reusable: false };
  const exact = answerForField(field, context.candidateAnswers || {});
  if (exact) return resolution(field, semanticKey, QUESTION_RESOLUTION.EXACT, exact.value, { evidenceRefs: [exact.fact || exact.source || 'CANDIDATE_KB'].filter(Boolean), source: exact.source || 'CANDIDATE_KB' });
  const planned = exactPlan(field, semanticKey, context.plan);
  if (planned != null) return resolution(field, semanticKey, QUESTION_RESOLUTION.EXACT, planned, { evidenceRefs: ['EXACT_APPLICATION_PLAN'], scope: 'JOB', reusable: false, source: 'EXACT_APPLICATION_PLAN' });
  const previous = previousAnswer(semanticKey, context.humanAnswers, context.answerMemory, context.jobId);
  if (previous) return resolution(field, semanticKey, QUESTION_RESOLUTION.PREVIOUS, previous.answer, { evidenceRefs: [previous.id || previous.source || 'VERIFIED_ANSWER'], scope: previous.scope, reusable: true, source: 'VERIFIED_ANSWER_MEMORY' });
  const subject = experienceSubject(semanticKey);
  if (subject) {
    const derived = deriveExperienceDuration({ subject, experience: context.candidateAnswers?.experience, skills: context.candidateAnswers?.skills, projects: context.candidateAnswers?.projects, asOf: context.now || new Date() });
    if (derived) return resolution(field, semanticKey, QUESTION_RESOLUTION.DERIVED, derived.years, { evidenceRefs: derived.evidenceRefs, source: derived.derivation });
  }
  const policy = policyAnswer(field, semanticKey, context.candidateAnswers);
  if (policy) return resolution(field, semanticKey, QUESTION_RESOLUTION.POLICY, policy.value, { evidenceRefs: policy.evidenceRefs, source: policy.source, scope: policy.scope || 'GLOBAL' });
  const generated = generatedAnswer(field, semanticKey, context.candidateAnswers);
  if (generated) return resolution(field, semanticKey, QUESTION_RESOLUTION.GENERATED, generated.value, { evidenceRefs: generated.evidenceRefs, source: generated.source, confidence: generated.confidence, scope: 'JOB', reusable: false });
  return { ...field, meaning: semanticKey, semanticKey, resolved: false, canonicalAnswer: false, resolutionType: QUESTION_RESOLUTION.HUMAN, resolution_type: QUESTION_RESOLUTION.HUMAN, confidence: 'NONE', evidenceRefs: [], evidence_refs: [], scope: 'JOB', reusable: false, source: null };
}

export function resolveApplicationQuestions(fields = [], context = {}) {
  const resolvedFields = fields.map(field => resolveApplicationQuestion(field, context));
  const counts = { fieldsInspected: resolvedFields.length, deterministic: 0, cached: 0, derived: 0, generated: 0, human: 0, sensitive: 0, llmCalls: 0 };
  for (const field of resolvedFields) {
    if (field.resolutionType === QUESTION_RESOLUTION.EXACT || field.resolutionType === QUESTION_RESOLUTION.POLICY) counts.deterministic += 1;
    else if (field.resolutionType === QUESTION_RESOLUTION.PREVIOUS) counts.cached += 1;
    else if (field.resolutionType === QUESTION_RESOLUTION.DERIVED) counts.derived += 1;
    else if (field.resolutionType === QUESTION_RESOLUTION.GENERATED) counts.generated += 1;
    else if (field.resolutionType === QUESTION_RESOLUTION.HUMAN) counts.human += 1;
    else if (field.resolutionType === QUESTION_RESOLUTION.SENSITIVE) counts.sensitive += 1;
  }
  return { fields: resolvedFields, metrics: counts };
}
