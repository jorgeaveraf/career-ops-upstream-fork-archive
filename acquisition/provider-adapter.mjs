import {
  ACQUISITION_CONTRACT_VERSION,
  AcquisitionFailure,
  acquisitionError,
  acquisitionFailure,
  acquisitionSuccess,
} from './contracts.mjs';
import { canonicalizeJobUrl, hashContent, inferExternalJobId, normalizeProviderId } from './normalize.mjs';

function timestamp(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError('retrievedAt must be a timestamp');
  return date.toISOString();
}

export function classifyAcquisitionError(error, providerId = 'unknown') {
  if (error instanceof AcquisitionFailure) return error.acquisitionError;
  const status = error?.status;
  const message = String(error?.message || error || 'provider unavailable');
  const retryAfterSeconds = Number(error?.retryAfter);
  if (status === 401) return acquisitionError({ code: 'AUTH_REQUIRED', providerId, safeMessage: message });
  if (status === 403) return acquisitionError({ code: 'BLOCKED', providerId, safeMessage: message });
  if (status === 404 || status === 410) return acquisitionError({ code: 'NOT_FOUND', providerId, safeMessage: message });
  if (status === 429) return acquisitionError({
    code: 'RATE_LIMITED', providerId, retryable: true, safeMessage: message,
    retryAfterMs: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined,
  });
  if (error?.name === 'AbortError' || /\b(?:timeout|timed out|ETIMEDOUT)\b/i.test(message)) {
    return acquisitionError({ code: 'TIMEOUT', providerId, retryable: true, safeMessage: message });
  }
  if (/captcha/i.test(message)) return acquisitionError({ code: 'CAPTCHA', providerId, retryable: false, safeMessage: message });
  if (/challenge|just a moment|checking your browser/i.test(message)) return acquisitionError({ code: 'CHALLENGE', providerId, retryable: true, safeMessage: message });
  if (/unexpected (?:API )?response|schema|fetch\(\) did not return an array/i.test(message)) {
    return acquisitionError({ code: 'SCHEMA_CHANGED', providerId, safeMessage: message });
  }
  return acquisitionError({
    code: 'UPSTREAM_UNAVAILABLE', providerId,
    retryable: status === undefined || (typeof status === 'number' && status >= 500),
    safeMessage: message,
  });
}

function fieldEvidence(field, value, provenance, source = {}) {
  return {
    field,
    value,
    confidence: source.confidence || 'high',
    extractionMethod: source.extractionMethod || 'direct',
    provenance,
  };
}

export function normalizeProviderJob(job, {
  providerId,
  providerVersion,
  fallbackCompany = '',
  runId = '',
  retrievedAt = new Date().toISOString(),
} = {}) {
  if (!job || typeof job !== 'object') throw new TypeError('provider job must be an object');
  const provider = normalizeProviderId(providerId);
  const sourceUrl = typeof job.url === 'string' ? job.url.trim() : '';
  const canonicalUrl = canonicalizeJobUrl(job.canonicalUrl || sourceUrl);
  const title = String(job.title || '').trim();
  if (!title || !sourceUrl || !canonicalUrl) throw new TypeError('provider job requires title and an absolute HTTP(S) url');
  const company = String(job.company || fallbackCompany || '').trim();
  const location = String(job.location || '').trim();
  const description = typeof job.description === 'string' ? job.description : '';
  const suppliedExternalId = String(job.externalId || '').trim();
  const externalId = suppliedExternalId || inferExternalJobId(provider, canonicalUrl);
  const at = timestamp(retrievedAt);
  const version = String(job.providerVersion || providerVersion || '').trim();
  const contentHash = String(job.contentHash || hashContent(description)).trim();
  const extractionMethod = ['direct', 'parsed', 'normalized', 'inferred'].includes(job.extractionMethod) ? job.extractionMethod : 'direct';
  const confidence = ['high', 'medium', 'low'].includes(job.confidence) ? job.confidence : 'high';
  const provenance = {
    providerId: provider,
    runId: String(runId || ''),
    retrievedAt: at,
    ...(externalId ? { externalId } : {}),
    sourceUrl,
    canonicalUrl,
    ...(version ? { providerVersion: version } : {}),
    ...(contentHash ? { contentHash } : {}),
    extractionMethod,
    adapterVersion: String(ACQUISITION_CONTRACT_VERSION),
  };
  const suppliedEvidence = Array.isArray(job.evidence) ? job.evidence : [];
  const byField = new Map(suppliedEvidence.filter(item => item?.field).map(item => [item.field, item]));
  const evidence = [
    ['title', title, 'direct'], ['company', company, 'direct'], ['location', location, 'direct'],
    ['canonicalUrl', canonicalUrl, 'normalized'],
    ['externalId', externalId, suppliedExternalId ? 'direct' : 'inferred'],
    ['contentHash', contentHash, 'normalized'],
  ].filter(([, value]) => value).map(([field, value, extractionMethod]) => fieldEvidence(
    field, value, provenance, byField.get(field) || { extractionMethod, confidence },
  ));
  return {
    ...job,
    title,
    url: sourceUrl,
    sourceUrl,
    canonicalUrl,
    company,
    location,
    description,
    ...(externalId ? { externalId } : {}),
    ...(version ? { providerVersion: version } : {}),
    contentHash,
    provenance,
    evidence,
    rawMetadata: {
      ...(job.rawMetadata && typeof job.rawMetadata === 'object' ? job.rawMetadata : {}),
      acquisitionContractVersion: ACQUISITION_CONTRACT_VERSION,
    },
  };
}

export async function acquireProvider(provider, entry, context, options = {}) {
  const attempts = [];
  const warnings = [];
  const retrievedAt = timestamp(options.retrievedAt);
  const providerId = normalizeProviderId(provider?.id);
  const attempt = {
    providerId,
    runId: String(options.runId || ''),
    retrievedAt,
    endpoint: String(options.endpoint || entry?.api || entry?.careers_url || ''),
    adapterVersion: String(ACQUISITION_CONTRACT_VERSION),
    extractionMethod: 'direct',
  };
  attempts.push(attempt);
  try {
    if (!providerId || typeof provider?.fetch !== 'function') throw new TypeError('provider must expose id and fetch()');
    const raw = await provider.fetch(entry, context);
    if (!Array.isArray(raw)) throw new TypeError(`${providerId}: fetch() did not return an array`);
    const jobs = [];
    for (let index = 0; index < raw.length; index++) {
      try {
        jobs.push(normalizeProviderJob(raw[index], {
          providerId, providerVersion: provider.version, fallbackCompany: entry?.name,
          runId: options.runId, retrievedAt,
        }));
      } catch (error) {
        warnings.push(`row ${index} rejected: ${error.message}`);
      }
    }
    return acquisitionSuccess(jobs, { attempts, warnings });
  } catch (error) {
    return acquisitionFailure(classifyAcquisitionError(error, providerId), { attempts, warnings });
  }
}

export function throwForAcquisitionFailure(result) {
  if (result?.ok) return result.data;
  throw new AcquisitionFailure(result?.error || acquisitionError({
    code: 'UPSTREAM_UNAVAILABLE', providerId: 'unknown', safeMessage: 'acquisition failed',
  }));
}

export function toNormalizedObservation(job, { providerId, runId, retrievedAt, trackedTarget } = {}) {
  const normalized = job?.provenance
    ? job
    : normalizeProviderJob(job, { providerId, runId, retrievedAt });
  return {
    provider: normalizeProviderId(providerId || normalized.provenance.providerId),
    providerVersion: normalized.provenance.providerVersion,
    externalId: normalized.externalId,
    sourceUrl: normalized.sourceUrl,
    canonicalUrl: normalized.canonicalUrl,
    title: normalized.title,
    company: normalized.company || String(trackedTarget || ''),
    location: normalized.location,
    description: normalized.description,
    contentHash: normalized.contentHash,
    postedAt: typeof normalized.postedAt === 'number' && Number.isFinite(normalized.postedAt)
      ? new Date(normalized.postedAt).toISOString()
      : normalized.postedAt,
    retrievedAt: normalized.provenance.retrievedAt,
    extractionMethod: normalized.provenance.extractionMethod,
    confidence: ['high', 'medium', 'low'].includes(normalized.confidence) ? normalized.confidence : 'high',
    evidence: normalized.evidence.map(item => ({
      field: item.field, value: item.value, confidence: item.confidence, extractionMethod: item.extractionMethod,
    })),
    rawMetadata: {
      ...normalized.rawMetadata,
      trackedTarget,
      salary: normalized.salary || null,
      provenance: normalized.provenance,
    },
  };
}
