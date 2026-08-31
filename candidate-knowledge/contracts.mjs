export const CANDIDATE_KB_SCHEMA_VERSION = 1;
export const KNOWLEDGE_STATUSES = Object.freeze(['CONFIRMED', 'INFERRED', 'UNKNOWN']);
export const KNOWLEDGE_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const GAP_STATUSES = Object.freeze(['UNKNOWN', 'PARTIAL', 'DEVELOPING', 'CONFIRMED_ABSENCE']);

/**
 * @typedef {object} CandidateKnowledgeMetadata
 * @property {number} schemaVersion
 * @property {number} version
 * @property {string} updatedAt
 * @property {string} hash
 * @property {string} revision
 * @property {Record<string,string>} sourceHashes
 */

/**
 * @typedef {object} CandidateKnowledgeResult
 * @property {'CONFIRMED'|'INFERRED'|'UNKNOWN'} status
 * @property {string} query
 * @property {object|null} skill
 * @property {object[]} projects
 * @property {object[]} evidence
 * @property {object[]} stories
 * @property {object[]} gaps
 * @property {string} explanation
 */
