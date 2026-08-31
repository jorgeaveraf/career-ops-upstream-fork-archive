// Documentation and runtime vocabulary for acquisition boundaries. Career Ops
// is plain ESM JavaScript; JSDoc preserves an incremental path from the current
// provider Job shape to evidence-bearing acquisition records.

/** @typedef {'high'|'medium'|'low'} EvidenceConfidence */
/** @typedef {'direct'|'parsed'|'normalized'|'inferred'|'legacy_import'} ExtractionMethod */

export const ACQUISITION_CONTRACT_VERSION = 1;

/**
 * @typedef {object} Provenance
 * @property {string} providerId
 * @property {string} runId
 * @property {string} retrievedAt
 * @property {string} [externalId]
 * @property {string} [sourceUrl]
 * @property {string} [canonicalUrl]
 * @property {string} [providerVersion]
 * @property {string} [contentHash]
 * @property {string} [endpoint]
 * @property {string} [adapterVersion]
 * @property {ExtractionMethod} extractionMethod
 */

/**
 * @template T
 * @typedef {object} Evidence
 * @property {T} value
 * @property {EvidenceConfidence} confidence
 * @property {ExtractionMethod} extractionMethod
 * @property {Provenance} provenance
 */

export const ACQUISITION_ERROR_CODES = Object.freeze([
  'AUTH_REQUIRED', 'RATE_LIMITED', 'BLOCKED', 'CAPTCHA', 'EMPTY_CONTENT',
  'CHALLENGE', 'NOT_JOB_CONTENT', 'NOT_FOUND', 'SCHEMA_CHANGED', 'TIMEOUT',
  'UPSTREAM_UNAVAILABLE', 'POLICY_DENIED',
]);

export const CONTENT_STATUSES = Object.freeze([
  'VALID', 'CAPTCHA', 'BLOCKED', 'EMPTY_CONTENT', 'LOGIN_REQUIRED', 'CHALLENGE',
  'NOT_JOB_CONTENT', 'NOT_FOUND', 'SCHEMA_CHANGED',
]);

/**
 * @typedef {object} AcquisitionError
 * @property {typeof ACQUISITION_ERROR_CODES[number]} code
 * @property {string} providerId
 * @property {boolean} retryable
 * @property {string} safeMessage
 * @property {number} [retryAfterMs]
 */

/**
 * @template T
 * @typedef {object} AcquisitionResult
 * @property {boolean} ok
 * @property {T} [data]
 * @property {Provenance[]} attempts
 * @property {string[]} warnings
 * @property {AcquisitionError} [error]
 */

/**
 * Raw provider output after the common adapter has made identity and source
 * evidence explicit. Legacy Job fields remain present for scanner compatibility.
 * @typedef {object} RawJobPosting
 * @property {string} title
 * @property {string} url
 * @property {string} company
 * @property {string} location
 * @property {string} [description]
 * @property {string} [externalId]
 * @property {string} canonicalUrl
 * @property {string} sourceUrl
 * @property {string} [providerVersion]
 * @property {string} contentHash
 * @property {Provenance} provenance
 * @property {Array<Evidence<unknown> & {field:string}>} evidence
 */

/**
 * Registry-ready observation. Providers never receive or persist this object.
 * @typedef {RawJobPosting & {provider:string,retrievedAt:string,rawMetadata:object}} NormalizedJobObservation
 */

/**
 * @typedef {{id:string, version?:string, fetch:(entry:object, context:object)=>Promise<object[]>, acquire?:(entry:object, context:object, options?:object)=>Promise<AcquisitionResult<RawJobPosting[]>>}} JobSearchProvider
 */

/**
 * @typedef {{id:string, version:string, read:(url:string, context:object)=>Promise<AcquisitionResult<{url:string,canonicalUrl:string,text:string,status:string,httpStatus?:number,readerId:string,retrievedAt:string,contentHash:string}>>}} PageReader
 */

export class AcquisitionFailure extends Error {
  constructor(acquisitionError, options = {}) {
    super(acquisitionError.safeMessage, options);
    this.name = 'AcquisitionFailure';
    this.code = acquisitionError.code;
    this.acquisitionCode = acquisitionError.code;
    this.providerId = acquisitionError.providerId;
    this.retryable = Boolean(acquisitionError.retryable);
    this.retryAfterMs = acquisitionError.retryAfterMs;
    this.acquisitionError = acquisitionError;
  }
}

export function acquisitionError({ code, providerId, retryable = false, safeMessage, retryAfterMs } = {}) {
  if (!ACQUISITION_ERROR_CODES.includes(code)) throw new TypeError(`unknown acquisition error code: ${code}`);
  const result = {
    code,
    providerId: String(providerId || 'unknown'),
    retryable: Boolean(retryable),
    safeMessage: String(safeMessage || code),
  };
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) result.retryAfterMs = retryAfterMs;
  return result;
}

export function acquisitionSuccess(data, { attempts = [], warnings = [] } = {}) {
  return { ok: true, data, attempts, warnings };
}

export function acquisitionFailure(error, { data, attempts = [], warnings = [] } = {}) {
  return { ok: false, ...(data === undefined ? {} : { data }), attempts, warnings, error };
}

export {};
