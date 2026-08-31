import {
  ACQUISITION_CONTRACT_VERSION,
  acquisitionError,
  acquisitionFailure,
  acquisitionSuccess,
} from './contracts.mjs';
import { validateContent } from './content-validation.mjs';
import { canonicalizeJobUrl, hashContent } from './normalize.mjs';
import { classifyAcquisitionError } from './provider-adapter.mjs';

const INVALID_TO_ERROR = Object.freeze({
  EMPTY_CONTENT: 'EMPTY_CONTENT',
  CAPTCHA: 'CAPTCHA',
  BLOCKED: 'BLOCKED',
  LOGIN_REQUIRED: 'AUTH_REQUIRED',
  CHALLENGE: 'CHALLENGE',
  NOT_JOB_CONTENT: 'NOT_JOB_CONTENT',
  NOT_FOUND: 'NOT_FOUND',
  SCHEMA_CHANGED: 'SCHEMA_CHANGED',
});

function publicTargetUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('PageReader URL must be absolute'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('PageReader URL must use HTTP(S)');
  if (url.username || url.password) throw new TypeError('PageReader URL must not contain credentials');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1'
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^169\.254\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) {
    throw new TypeError('PageReader URL must target the public web');
  }
  return url.href;
}

function pageAttempt({ readerId, url, retrievedAt, endpoint }) {
  return {
    providerId: readerId,
    runId: '',
    retrievedAt,
    sourceUrl: url,
    canonicalUrl: canonicalizeJobUrl(url),
    endpoint,
    adapterVersion: String(ACQUISITION_CONTRACT_VERSION),
    extractionMethod: 'parsed',
  };
}

function pageResult({ readerId, url, text, httpStatus = 200, retrievedAt, endpoint }) {
  const validation = validateContent({ httpStatus, text, expectedJob: true });
  const data = {
    url,
    canonicalUrl: canonicalizeJobUrl(url),
    text: typeof text === 'string' ? text : '',
    status: validation.status,
    reason: validation.reason,
    httpStatus,
    readerId,
    retrievedAt,
    contentHash: hashContent(text),
  };
  const attempts = [pageAttempt({ readerId, url, retrievedAt, endpoint })];
  if (validation.status === 'VALID') return acquisitionSuccess(data, { attempts });
  const code = INVALID_TO_ERROR[validation.status] || 'UPSTREAM_UNAVAILABLE';
  return acquisitionFailure(acquisitionError({
    code,
    providerId: readerId,
    retryable: ['CHALLENGE', 'BLOCKED'].includes(validation.status),
    safeMessage: `${readerId}: ${validation.reason}`,
  }), { data, attempts });
}

export class DirectPageReader {
  constructor({ clock = () => new Date() } = {}) {
    this.id = 'direct-http';
    this.version = '1';
    this.clock = clock;
  }

  async read(value, context) {
    let url;
    const retrievedAt = this.clock().toISOString();
    try {
      url = publicTargetUrl(value);
      if (typeof context?.fetchText !== 'function') throw new TypeError('DirectPageReader requires context.fetchText');
      const text = await context.fetchText(url, { redirect: 'error' });
      return pageResult({ readerId: this.id, url, text, retrievedAt, endpoint: url });
    } catch (error) {
      const classified = classifyAcquisitionError(error, this.id);
      return acquisitionFailure(classified, {
        attempts: url ? [pageAttempt({ readerId: this.id, url, retrievedAt, endpoint: url })] : [],
      });
    }
  }
}

export class JinaPageReader {
  constructor({ clock = () => new Date(), endpoint = 'https://r.jina.ai' } = {}) {
    this.id = 'jina-reader';
    this.version = '1';
    this.clock = clock;
    this.endpoint = endpoint.replace(/\/+$/, '');
  }

  async read(value, context) {
    let url;
    const retrievedAt = this.clock().toISOString();
    try {
      url = publicTargetUrl(value);
      if (typeof context?.fetchText !== 'function') throw new TypeError('JinaPageReader requires context.fetchText');
      const readerUrl = `${this.endpoint}/${url}`;
      const text = await context.fetchText(readerUrl, { redirect: 'error' });
      return pageResult({ readerId: this.id, url, text, retrievedAt, endpoint: this.endpoint });
    } catch (error) {
      const classified = classifyAcquisitionError(error, this.id);
      return acquisitionFailure(classified, {
        attempts: url ? [pageAttempt({ readerId: this.id, url, retrievedAt, endpoint: this.endpoint })] : [],
      });
    }
  }
}

export function pageReaderErrorCode(status) {
  return INVALID_TO_ERROR[status] || 'UPSTREAM_UNAVAILABLE';
}
