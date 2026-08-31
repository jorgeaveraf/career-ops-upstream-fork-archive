import { hashContent, hashStable } from '../acquisition/normalize.mjs';
import { BROWSER_RESEARCH_PROVENANCE_MODE } from './browser-policy.mjs';

export const BROWSER_RESEARCH_ENTITY_TYPES = Object.freeze(['PAGE', 'JOB', 'COMPANY', 'CONTACT']);
export const BROWSER_RESEARCH_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);

export class BrowserResearchProvider {
  constructor({ adapter, id = 'browser-research', version = '1', clock = () => new Date() } = {}) {
    if (!adapter || typeof adapter.read !== 'function') throw new TypeError('a read-only browser adapter is required');
    this.adapter = adapter; this.id = id; this.version = version; this.clock = clock;
  }

  async research({ tasks = [], session, runId } = {}) {
    if (!session) throw new TypeError('browser session is required');
    const observations = []; const failures = [];
    for (const task of tasks) {
      try {
        const result = await this.adapter.read({ task, session });
        for (const finding of result.findings || []) observations.push(validateBrowserResearchObservation({
          ...finding,
          sourceUrl: finding.sourceUrl || result.finalUrl || task.url,
          retrievedAt: finding.retrievedAt || result.retrievedAt || this.clock().toISOString(),
          source: finding.source || task.source,
          extractionMethod: finding.extractionMethod || 'parsed', confidence: finding.confidence || 'low',
          evidence: finding.evidence || [],
          provenance: {
            ...(finding.provenance || {}),
            providerId: this.id, providerVersion: this.version, runId,
            profile: session.profile, profileDirectory: session.profileDirectory,
            mode: BROWSER_RESEARCH_PROVENANCE_MODE, source: task.source, taskId: task.id,
            extractionMethod: finding.extractionMethod || 'parsed', actions: [],
            contentHash: finding.contentHash || hashContent(result.text || ''),
          },
        }));
      } catch (error) {
        failures.push({ taskId: task.id, source: task.source, code: error.code || 'BROWSER_READ_FAILED', message: error.message });
      }
    }
    return { observations, failures, pages: tasks.length };
  }
}

export function validateBrowserResearchObservation(observation) {
  const required = ['entityType', 'sourceUrl', 'retrievedAt', 'source', 'extractionMethod', 'confidence', 'evidence', 'provenance'];
  const missing = required.filter(field => observation?.[field] == null || (field === 'evidence' && !Array.isArray(observation.evidence)));
  if (missing.length) throw new TypeError(`browser research observation missing: ${missing.join(', ')}`);
  if (!BROWSER_RESEARCH_ENTITY_TYPES.includes(observation.entityType)) throw new TypeError(`invalid browser research entity type: ${observation.entityType}`);
  if (!BROWSER_RESEARCH_CONFIDENCE.includes(observation.confidence)) throw new TypeError(`invalid browser research confidence: ${observation.confidence}`);
  if (!['direct', 'parsed', 'normalized', 'inferred'].includes(observation.extractionMethod)) throw new TypeError('invalid browser research extraction method');
  const url = new URL(observation.sourceUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('browser research source must be HTTP(S)');
  const at = new Date(observation.retrievedAt);
  if (Number.isNaN(at.getTime())) throw new TypeError('browser research retrievedAt must be an ISO timestamp');
  if (observation.provenance.mode !== BROWSER_RESEARCH_PROVENANCE_MODE) throw new TypeError(`browser research provenance mode must be ${BROWSER_RESEARCH_PROVENANCE_MODE}`);
  if (observation.provenance.actions?.length) throw new TypeError('browser research observations cannot contain performed actions');
  if (observation.provenance.profile !== 'jorge') throw new TypeError('browser research provenance must use the jorge profile');
  if (observation.entityType === 'JOB') {
    for (const field of ['title', 'company']) if (!String(observation.data?.[field] || '').trim()) throw new TypeError(`browser JOB finding requires ${field}`);
  }
  if (observation.entityType === 'CONTACT') {
    const status = observation.data?.relationshipStatus || 'UNKNOWN';
    if (!['CONFIRMED', 'UNKNOWN'].includes(status)) throw new TypeError('contact relationship status must be CONFIRMED or UNKNOWN');
    if (status === 'CONFIRMED' && !observation.evidence.length) throw new TypeError('confirmed contact relationship requires evidence');
  }
  const clone = structuredClone(observation);
  if (clone.entityType === 'CONTACT') clone.data = { ...(clone.data || {}), relationshipStatus: clone.data?.relationshipStatus || 'UNKNOWN' };
  clone.observationKey = clone.observationKey || hashStable(JSON.stringify({
    entityType: clone.entityType, sourceUrl: url.toString(), data: clone.data || {}, evidence: clone.evidence,
    contentHash: clone.provenance.contentHash || '',
  }));
  return clone;
}

export function toRegistryJobObservation(observation) {
  const item = validateBrowserResearchObservation(observation);
  if (item.entityType !== 'JOB') return null;
  return {
    provider: 'browser-research', externalId: item.data.externalId || '', sourceUrl: item.sourceUrl,
    canonicalUrl: item.data.canonicalUrl || item.sourceUrl, title: item.data.title,
    company: item.data.company, location: item.data.location || '', description: item.data.description || '',
    postedAt: item.data.postedAt || null, retrievedAt: item.retrievedAt, evidence: item.evidence,
    rawMetadata: { browserResearch: true, observationKey: item.observationKey, provenance: item.provenance },
  };
}
