import { normalizeJobCompany, normalizeJobTitle } from '../acquisition/normalize.mjs';

export const ENRICHMENT_RESOLVER_VERSION = 'browser-evidence-1.0';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function validateCandidateIdentity(candidate, record) {
  const expectedExternalId = clean(candidate.externalId);
  const actualExternalId = clean(record.externalId || record.external_id);
  if (expectedExternalId && actualExternalId && expectedExternalId === actualExternalId) return { valid: true, method: 'external_id', confidence: 'high' };
  const expectedUrl = clean(candidate.canonicalUrl || candidate.sourceUrl).replace(/[?#].*$/, '');
  const actualUrl = clean(record.canonicalUrl || record.detailUrl || record.url).replace(/[?#].*$/, '');
  if (expectedUrl && actualUrl && (expectedUrl === actualUrl || actualUrl.startsWith(expectedUrl) || expectedUrl.startsWith(actualUrl))) return { valid: true, method: 'canonical_url', confidence: 'high' };
  const title = normalizeJobTitle(record.detailTitle || record.title); const company = normalizeJobCompany(record.company);
  if (title && company && title === normalizeJobTitle(candidate.title) && company === normalizeJobCompany(candidate.company)) return { valid: true, method: 'title_company', confidence: 'medium' };
  return { valid: false, code: 'EVIDENCE_IDENTITY_UNCERTAIN', confidence: 'low', expected: { externalId: expectedExternalId, title: candidate.title, company: candidate.company, url: expectedUrl }, observed: { externalId: actualExternalId, title: record.detailTitle || record.title, company: record.company, url: actualUrl } };
}

export function extractCandidateEvidence(record, { source, retrievedAt }) {
  const description = clean(record.fullDescription || record.description); const hay = `${record.location || ''} ${description}`;
  const evidence = []; const add = (field, value, confidence = 'medium') => { if (value != null && clean(value)) evidence.push({ field, value, confidence, extractionMethod: 'parsed', sourceUrl: record.detailUrl || record.canonicalUrl || record.url, source, retrievedAt, resolverVersion: ENRICHMENT_RESOLVER_VERSION }); };
  if (description.length >= 200) add('description', description, 'high');
  if (/\b(m[eé]xico|mexico)\b/i.test(hay)) add('eligibleCountries', ['Mexico'], /eligible|available|remote.*m[eé]xico/i.test(hay) ? 'high' : 'medium');
  const remote = hay.match(/\b(worldwide|global|latam|latin america|remote(?:ly)?(?: from)? mexico|m[eé]xico)\b/i)?.[1]; if (remote) add('remoteScope', remote);
  const employment = clean(record.employmentType) || hay.match(/\b(full[- ]time|part[- ]time|contract(?:or)?|freelance|employee)\b/i)?.[1]; if (employment) add('employmentType', employment);
  const compensation = clean(record.compensation) || hay.match(/(?:USD|US\$|MXN|\$)\s?[\d,.]+(?:\s*[-–]\s*(?:USD|US\$|MXN|\$)?\s?[\d,.]+)?(?:\s*(?:\/|per )\s*(?:year|month|hour|año|mes|hora))?/i)?.[0]; if (compensation) add('compensation', { raw: compensation });
  const schedule = hay.match(/\b(?:\d{1,2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}\s*(?:am|pm)|[A-Z]{2,4}\s*time|flexible hours|horario flexible)\b/i)?.[0]; if (schedule) add('schedule', schedule);
  const market = hay.match(/\b(global company|international company|us[- ]based|mexico[- ]based|latin american company)\b/i)?.[0]; if (market) add('companyMarket', market);
  if (description.length >= 200 && !/talent pool|talent network|future opportunities/i.test(description)) add('postingIsReal', true, 'medium');
  add('canonicalUrl', record.canonicalUrl || record.detailUrl || record.url, 'high');
  add('postedAt', record.postedAt, 'medium'); add('applicationPath', record.applicationPath, 'medium');
  return evidence;
}

export function evidenceResolvesNeed(need, evidence) {
  const fields = new Set(evidence.map(item => item.field));
  return ({ FETCH_FULL_DESCRIPTION: ['description'], CONFIRM_MEXICO_ELIGIBILITY: ['eligibleCountries'],
    CONFIRM_REMOTE_SCOPE: ['remoteScope'], CONFIRM_EMPLOYMENT_MODEL: ['employmentType'], CONFIRM_COMPENSATION: ['compensation'],
    CONFIRM_COMPANY_MARKET: ['companyMarket'], CONFIRM_SCHEDULE: ['schedule'], RESOLVE_LOCATION_CONFLICT: ['eligibleCountries', 'remoteScope'],
    CONFIRM_POSTING_IS_REAL: ['postingIsReal'] })[need.type]?.some(field => fields.has(field)) || false;
}
