import { hashStable } from '../acquisition/normalize.mjs';
import { CONTACT_CONFIDENCE, PUBLIC_SOURCE_TYPES } from './contracts.mjs';

const BLOCKED_HOSTS = /(^|\.)(facebook\.com)$/i;
const FIELD_ALIASES = Object.freeze({
  profileUrl: 'profile_url', careersUrl: 'careers_url', relevantUrls: 'relevant_urls',
  visibleTechnologies: 'visible_technologies', publicCulture: 'public_culture',
});
const CONFIDENCE_WEIGHT = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3 });

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function normalizeIdentity(value) {
  return normalizeText(value).toLocaleLowerCase('en').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

export function normalizeDomain(value) {
  const raw = normalizeText(value).toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  if (!raw || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) || BLOCKED_HOSTS.test(raw)) return '';
  return raw;
}

export function normalizePublicUrl(value) {
  try {
    const url = new URL(normalizeText(value));
    if (!['http:', 'https:'].includes(url.protocol) || BLOCKED_HOSTS.test(url.hostname)) return '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch { return ''; }
}

export function normalizeConfidence(value, fallback = 'LOW') {
  const confidence = normalizeText(value).toUpperCase();
  return CONTACT_CONFIDENCE.includes(confidence) ? confidence : fallback;
}

export function highestConfidence(values, fallback = 'LOW') {
  return values.map(value => normalizeConfidence(value)).sort((a, b) => CONFIDENCE_WEIGHT[b] - CONFIDENCE_WEIGHT[a])[0] || fallback;
}

export function normalizeField(value) {
  const raw = normalizeText(value);
  return FIELD_ALIASES[raw] || raw.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

export function normalizeEvidence(item, defaults = {}) {
  if (!item || typeof item !== 'object') return null;
  const field = normalizeField(item.field || defaults.field);
  const source = item.source || item.provenance || {};
  const sourceType = normalizeText(source.sourceType || source.type || defaults.sourceType).toUpperCase();
  const providerId = normalizeText(source.providerId || defaults.providerId);
  if (!field || !providerId || !PUBLIC_SOURCE_TYPES.includes(sourceType)) return null;
  const sourceUrl = source.sourceUrl ? normalizePublicUrl(source.sourceUrl) : '';
  if (source.sourceUrl && !sourceUrl) return null;
  const value = item.value;
  if (value == null || (typeof value === 'string' && !normalizeText(value))) return null;
  if (['profile_url', 'careers_url'].includes(field) && !normalizePublicUrl(value)) return null;
  if (field === 'relevant_urls' && (Array.isArray(value) ? value : [value]).some(url => !normalizePublicUrl(url))) return null;
  if (field === 'domain' && !normalizeDomain(value)) return null;
  const sourceHash = normalizeText(source.sourceHash || source.contentHash) || hashStable(JSON.stringify({ providerId, sourceType, sourceUrl, field, value }));
  const confidence = normalizeConfidence(item.confidence);
  const extractionMethod = normalizeText(item.extractionMethod || source.extractionMethod || 'DIRECT').toUpperCase();
  const retrievedAt = source.retrievedAt || defaults.retrievedAt || null;
  const identity = { field, value, confidence, extractionMethod, providerId, sourceType, sourceUrl, sourceHash };
  return {
    id: `evidence:${hashStable(JSON.stringify(identity))}`,
    field, value, confidence, extractionMethod,
    source: { providerId, providerVersion: normalizeText(source.providerVersion || defaults.providerVersion) || null, sourceType, sourceUrl: sourceUrl || null, sourceHash, retrievedAt },
  };
}

export function evidenceFor(evidence, field) {
  const wanted = normalizeField(field);
  return evidence.filter(item => item.field === wanted && item.extractionMethod !== 'INFERRED');
}

export function stableSourceHash(evidence) {
  return hashStable(JSON.stringify(evidence.map(item => ({
    field: item.field, value: item.value, confidence: item.confidence,
    extractionMethod: item.extractionMethod, providerId: item.source.providerId,
    sourceType: item.source.sourceType, sourceUrl: item.source.sourceUrl,
    sourceHash: item.source.sourceHash,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
}
