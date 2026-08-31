export const DEEP_EVALUATION_ENGINE_VERSION = '1';
export const DEEP_EVALUATION_PROMPT_VERSION = '1';
export const MATCH_STATUSES = Object.freeze([
  'STRONG_MATCH', 'PARTIAL_MATCH', 'TRANSFERABLE_EXPERIENCE', 'NO_EVIDENCE', 'CONFLICTING_EVIDENCE',
]);
export const GAP_KINDS = Object.freeze(['missing', 'weak', 'developing', 'confirmed_absence']);
export const RECOMMENDATIONS = Object.freeze(['APPLY', 'CONSIDER', 'DO_NOT_APPLY']);
export const EVALUATION_CONFIDENCE = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);

const evidenceList = { type: 'array', items: { type: 'string' } };

export const EVALUATION_OUTPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['recommendation', 'confidence', 'overall_fit', 'summary', 'strengths', 'evidence_used', 'gaps', 'positioning', 'interview_focus', 'risks'],
  properties: {
    recommendation: { type: 'string', enum: RECOMMENDATIONS },
    confidence: { type: 'string', enum: EVALUATION_CONFIDENCE },
    overall_fit: { type: 'integer', minimum: 0, maximum: 100 },
    summary: { type: 'string' },
    strengths: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['requirement_id', 'evidence_ids', 'summary'],
        properties: { requirement_id: { type: 'string' }, evidence_ids: evidenceList, summary: { type: 'string' } },
      },
    },
    evidence_used: evidenceList,
    gaps: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['requirement_id', 'gap_ids', 'status', 'recommendation'],
        properties: {
          requirement_id: { type: 'string' }, gap_ids: evidenceList,
          status: { type: 'string', enum: GAP_KINDS }, recommendation: { type: 'string' },
        },
      },
    },
    positioning: {
      type: 'object', additionalProperties: false, required: ['emphasize', 'avoid'],
      properties: {
        emphasize: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['text', 'evidence_ids'],
          properties: { text: { type: 'string' }, evidence_ids: evidenceList },
        } },
        avoid: { type: 'array', items: { type: 'string' } },
      },
    },
    interview_focus: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['topic', 'evidence_ids'],
      properties: { topic: { type: 'string' }, evidence_ids: evidenceList },
    } },
    risks: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['text', 'requirement_ids', 'evidence_ids'],
      properties: { text: { type: 'string' }, requirement_ids: evidenceList, evidence_ids: evidenceList },
    } },
  },
});

