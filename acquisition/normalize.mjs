import { createHash } from 'crypto';
import { normalizeJdText } from '../fingerprint-core.mjs';
import { normalizeCompanyName } from '../invite-match.mjs';

const TRACKING_PARAMS = new Set([
  'language', 'lang', 'locale',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'src', 'source', 'gh_src', 'lever-origin', 'lever-source', 'rltr',
]);

export function canonicalizeJobUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = (url.pathname.replace(/\/+$/, '') || '/').toLowerCase();
    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeProviderId(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

export function normalizeJobTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeJobCompany(value) {
  return normalizeCompanyName(String(value ?? '')).normalize('NFKC').trim();
}

export function normalizeJobLocation(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashContent(value) {
  const normalized = normalizeJdText(value);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : '';
}

export function hashStable(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** Extract a stable ID only from URL shapes whose ID location is well-known. */
export function inferExternalJobId(providerId, value) {
  const provider = normalizeProviderId(providerId).replace(/-api$/, '');
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return '';
  }
  if (provider === 'greenhouse') {
    return url.searchParams.get('gh_jid') || url.pathname.match(/\/jobs\/(\d+)(?:\/|$)/)?.[1] || '';
  }
  if (provider === 'ashby') {
    return url.pathname.split('/').filter(Boolean).at(-1) || '';
  }
  if (provider === 'lever') {
    return url.pathname.split('/').filter(Boolean).at(-1) || '';
  }
  if (provider === 'workday') {
    return url.pathname.match(/[_-]([A-Z]*-?\d+(?:-\d+)?)$/i)?.[1] || '';
  }
  return '';
}

export function observationSnapshotHash(input) {
  return hashStable(JSON.stringify({
    provider: normalizeProviderId(input.provider),
    externalId: String(input.externalId ?? '').trim(),
    sourceUrl: canonicalizeJobUrl(input.sourceUrl),
    canonicalUrl: canonicalizeJobUrl(input.canonicalUrl || input.sourceUrl),
    title: normalizeJobTitle(input.title),
    company: normalizeJobCompany(input.company),
    location: normalizeJobLocation(input.location),
    contentHash: input.contentHash || hashContent(input.description),
    postedAt: input.postedAt || null,
  }));
}
