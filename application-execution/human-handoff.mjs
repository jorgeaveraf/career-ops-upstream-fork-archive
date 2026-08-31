import { hashStable } from '../acquisition/normalize.mjs';

export const HUMAN_HANDOFF_TYPES = Object.freeze([
  'CAPTCHA_REQUIRED', 'MFA_REQUIRED', 'LOGIN_REAUTH_REQUIRED', 'SECURITY_CHALLENGE',
  'REAL_HUMAN_FACT_REQUIRED', 'LEGAL_ATTESTATION_REQUIRED', 'PLATFORM_CONFIRMATION_REQUIRED',
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const key = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const choices = field => (field?.allowedValues || field?.options || []).map(item => typeof item === 'object' ? clean(item.label || item.value) : clean(item)).filter(Boolean);

export function classifyAnswerPersistence(question = '') {
  const value = clean(question).toLowerCase();
  if (/english|ingl[eé]s|python.*years|years.*python|aws bedrock/.test(value)) return 'REUSABLE_GLOBAL';
  if (/compensation|salary|monthly expectation|sueldo|salario/.test(value)) return 'JOB_SPECIFIC';
  if (/legal|attest|certify|signature/.test(value)) return 'DO_NOT_PERSIST';
  return 'REUSABLE_SCOPED';
}

export function normalizeHandoffQuestion(field = {}, index = 0) {
  const prompt = clean(field.prompt || field.question || field.label || field.name);
  if (!prompt) throw new TypeError('handoff question prompt is required');
  const allowedValues = choices(field);
  const fieldKey = key(field.fieldKey || field.field_key || field.name || prompt) || `question_${index + 1}`;
  return Object.freeze({
    questionId: clean(field.questionId || field.question_id) || `handoff-question-${hashStable(`${fieldKey}:${prompt}`)}`,
    fieldKey, prompt, helpText: clean(field.helpText || field.help_text || field.context || 'Provide the exact truthful value.'),
    answerType: allowedValues.length ? 'ENUM' : (/how many years|years of/i.test(prompt) ? 'NUMBER_OR_RANGE' : 'TEXT'),
    allowedValues: Object.freeze(allowedValues), persistence: field.persistence || classifyAnswerPersistence(prompt),
  });
}

export function humanHandoffPresentation(type, questionCount = 0) {
  const count = Math.max(0, Number(questionCount) || 0);
  const map = {
    CAPTCHA_REQUIRED: ['Solve CAPTCHA', 'Career Ops already prepared the application. Open it, solve only the CAPTCHA, then leave the tab open. Career Ops will continue automatically.', 'WAITING ON CAPTCHA'],
    MFA_REQUIRED: ['Complete MFA', 'Complete only the MFA step in the prepared application session, then leave it open. Career Ops will continue automatically.', 'WAITING ON MFA'],
    LOGIN_REAUTH_REQUIRED: ['Complete login', 'Complete only login or reauthentication in the prepared session, then leave it open. Career Ops will continue automatically.', 'WAITING ON LOGIN'],
    SECURITY_CHALLENGE: ['Complete security check', 'Complete only the security check in the prepared session, then leave it open. Career Ops will continue automatically.', 'WAITING ON SECURITY CHECK'],
    REAL_HUMAN_FACT_REQUIRED: [`Answer ${count || 1} application question${count === 1 ? '' : 's'}`, 'Answer the bundled questions in TODAY once and use Sync Jobs. Career Ops will validate the answers and continue the same application automatically.', `WAITING ON ${count || 1} ANSWER${count === 1 ? '' : 'S'}`],
    LEGAL_ATTESTATION_REQUIRED: ['Complete legal attestation', 'Review and complete only the required personal legal attestation. Career Ops will continue the application afterward.', 'WAITING ON LEGAL ATTESTATION'],
    PLATFORM_CONFIRMATION_REQUIRED: ['Confirm platform state', 'Confirm only the platform state requested. Career Ops will continue or remain verification-only as appropriate.', 'WAITING ON CONFIRMATION'],
  };
  const [action, instruction, progress] = map[type] || map.PLATFORM_CONFIRMATION_REQUIRED;
  return { action, instruction, progress };
}

export function buildHumanHandoff({ execution, type, fields = [], blocker = {}, session = {}, batchId = null } = {}) {
  if (!execution?.id || !execution?.jobId) throw new TypeError('execution is required');
  if (!HUMAN_HANDOFF_TYPES.includes(type)) throw new TypeError(`invalid handoff type: ${type}`);
  const sourceQuestions = fields.length ? fields : (blocker.requiredQuestions || blocker.questions || (blocker.question ? [{ question: blocker.question, field: blocker.field }] : []));
  const questions = type === 'REAL_HUMAN_FACT_REQUIRED' || type === 'LEGAL_ATTESTATION_REQUIRED'
    ? sourceQuestions.map((item, index) => normalizeHandoffQuestion(typeof item === 'string' ? { question: item } : item, index)) : [];
  const presentation = humanHandoffPresentation(type, questions.length);
  return Object.freeze({ executionId: execution.id, jobId: execution.jobId, batchId: batchId || execution.batchId || null, handoffType: type,
    ...presentation, openUrl: clean(blocker.url || session.currentUrl), questions, evidence: { preSubmit: execution.mutationState === 'PRE_SUBMIT', completedFields: blocker.completedFields || [], source: blocker.evidence?.source || 'APPLICATION_EXECUTOR' }, session });
}

export function formatQuestionBundle(questions = []) {
  return questions.map((item, index) => `${index + 1}. ${item.prompt}${item.allowedValues?.length ? `\n   Options: ${item.allowedValues.join(' | ')}` : ''}`).join('\n\n');
}

export function parseBundledAnswers(input, questions = []) {
  if (!questions.length) return { ok: true, answers: [] };
  if (questions.length === 1 && typeof input !== 'object') return validateAnswers({ [questions[0].fieldKey]: clean(input) }, questions);
  let values = input;
  if (typeof input === 'string') {
    const raw = input.trim();
    try { values = JSON.parse(raw); }
    catch {
      const lines = raw.split(/\n+/).map(value => value.trim()).filter(Boolean);
      values = Object.fromEntries(lines.map((line, index) => {
        const match = line.match(/^(?:\d+[.)]\s*)?([^:=]+)\s*[:=]\s*(.+)$/);
        return match ? [key(match[1]), match[2].trim()] : [questions[index]?.fieldKey, line.replace(/^\d+[.)]\s*/, '')];
      }).filter(([fieldKey]) => fieldKey));
    }
  }
  return validateAnswers(values, questions);
}

function validateAnswers(values, questions) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return { ok: false, error: 'Answer the complete question bundle.' };
  const answers = [];
  for (const question of questions) {
    let value = values[question.fieldKey];
    if (value == null) value = Object.entries(values).find(([candidate]) => key(candidate) === question.fieldKey)?.[1];
    value = clean(value); if (!value) return { ok: false, error: `Missing answer: ${question.prompt}` };
    if (question.allowedValues.length && !question.allowedValues.some(option => clean(option).toLowerCase() === value.toLowerCase())) return { ok: false, error: `Choose one allowed value for: ${question.prompt}` };
    if (question.answerType === 'NUMBER_OR_RANGE' && !/\d/.test(value)) return { ok: false, error: `Use a numeric value or displayed range for: ${question.prompt}` };
    answers.push({ ...question, answer: value });
  }
  return { ok: true, answers };
}

