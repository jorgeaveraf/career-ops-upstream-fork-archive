export const APPLICATION_PACKAGE_ENGINE_VERSION = '1.1';
export const APPLICATION_PACKAGE_PROMPT_VERSION = '1';
export const APPLICATION_PACKAGE_STATUSES = Object.freeze(['DRAFT', 'REVIEW_REQUIRED', 'APPROVED', 'ARCHIVED']);
export const ADAPTATION_TYPES = Object.freeze(['DIRECT', 'WORDING_ADAPTATION', 'JOB_CONTEXT']);

const refs = { type: 'array', items: { type: 'string' } };
const sourcedText = {
  type: 'object', additionalProperties: false,
  required: ['text', 'evidence_refs', 'requirement_refs', 'adaptation'],
  properties: {
    text: { type: 'string' }, evidence_refs: refs, requirement_refs: refs,
    adaptation: { type: 'string', enum: ADAPTATION_TYPES },
  },
};

export const APPLICATION_PACKAGE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['resume_variant', 'cover_letter', 'outreach', 'application_notes'],
  properties: {
    resume_variant: {
      type: 'object', additionalProperties: false,
      required: ['summary', 'highlighted_skills', 'selected_projects', 'experience_emphasis', 'keywords', 'changes_from_base', 'evidence_refs'],
      properties: {
        summary: sourcedText,
        highlighted_skills: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['skill_id', 'name', 'evidence_refs'],
          properties: { skill_id: { type: 'string' }, name: { type: 'string' }, evidence_refs: refs },
        } },
        selected_projects: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['project_id', 'name', 'emphasis', 'evidence_refs'],
          properties: { project_id: { type: 'string' }, name: { type: 'string' }, emphasis: sourcedText, evidence_refs: refs },
        } },
        experience_emphasis: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['experience_id', 'company', 'role', 'project_ids', 'evidence_refs'],
          properties: { experience_id: { type: 'string' }, company: { type: 'string' }, role: { type: 'string' }, project_ids: refs, evidence_refs: refs },
        } },
        keywords: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['term', 'requirement_id', 'evidence_refs'],
          properties: { term: { type: 'string' }, requirement_id: { type: 'string' }, evidence_refs: refs },
        } },
        changes_from_base: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['section', 'change', 'reason', 'evidence_refs'],
          properties: { section: { type: 'string' }, change: { type: 'string' }, reason: { type: 'string' }, evidence_refs: refs },
        } },
        evidence_refs: refs,
      },
    },
    cover_letter: {
      type: 'object', additionalProperties: false, required: ['content', 'paragraphs', 'evidence_refs', 'tone'],
      properties: {
        content: { type: 'string' },
        paragraphs: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['purpose', 'text', 'evidence_refs', 'requirement_refs', 'adaptation'],
          properties: { purpose: { type: 'string' }, text: { type: 'string' }, evidence_refs: refs, requirement_refs: refs, adaptation: { type: 'string', enum: ADAPTATION_TYPES } },
        } },
        evidence_refs: refs, tone: { type: 'string' },
      },
    },
    outreach: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'subject', 'content', 'evidence_refs', 'requirement_refs'],
        properties: {
          type: { type: 'string', enum: ['RECRUITER_MESSAGE', 'HIRING_MANAGER_MESSAGE', 'EMAIL_INTRODUCTION'] },
          subject: { type: 'string' }, content: { type: 'string' }, evidence_refs: refs, requirement_refs: refs,
        },
      },
    },
    application_notes: {
      type: 'object', additionalProperties: false,
      required: ['why_apply', 'strongest_arguments', 'concerns', 'interview_focus', 'questions_to_ask', 'salary_notes'],
      properties: {
        why_apply: { type: 'array', items: sourcedText }, strongest_arguments: { type: 'array', items: sourcedText },
        concerns: { type: 'array', items: sourcedText }, interview_focus: { type: 'array', items: sourcedText },
        questions_to_ask: { type: 'array', items: sourcedText }, salary_notes: { type: 'string' },
      },
    },
  },
});
