import { canonicalizeJobUrl } from '../acquisition/normalize.mjs';

const UNKNOWN = 'UNKNOWN';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const first = (...values) => values.map(clean).find(Boolean) || UNKNOWN;

function safeUrl(value, base, allowedHosts) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || !allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return '';
    return url.toString();
  } catch { return ''; }
}

function commonJob(record, { source, baseUrl, allowedHosts, externalId }) {
  const url = safeUrl(record.url, baseUrl, allowedHosts);
  if (!url || !clean(record.title)) return null;
  return {
    title: clean(record.title), url, canonicalUrl: canonicalizeJobUrl(record.canonicalUrl || url),
    externalId: clean(externalId) || undefined,
    company: first(record.company), location: first(record.location),
    modality: first(record.modality), description: first(record.description),
    confidence: clean(record.confidence).toLowerCase() || 'medium', extractionMethod: 'parsed',
    evidence: ['title', 'company', 'location', 'modality', 'description'].map(field => ({
      field, value: first(record[field]), confidence: clean(record[field]) ? 'medium' : 'low', extractionMethod: 'parsed',
    })),
    rawMetadata: { browserDiscovery: true, source, modality: first(record.modality) },
  };
}

function queryTerms(task, extras = []) {
  const terms = clean(task.query).split(/\s+/).filter(Boolean);
  if (task.filters?.remote && !terms.some(term => /^remote$/i.test(term))) terms.push('remote');
  if (task.filters?.seniority === 'senior' && !terms.some(term => /^senior$/i.test(term))) terms.push('senior');
  for (const extra of extras) if (extra && !terms.some(term => term.toLowerCase() === extra.toLowerCase())) terms.push(extra);
  return terms.join(' ');
}

export class LinkedInDiscoverySourceAdapter {
  constructor() { this.id = 'linkedin'; this.version = '1'; }
  buildSearchUrl(task) {
    if (task.mode === 'personalized_feed') return 'https://www.linkedin.com/jobs/collections/recommended/';
    const url = new URL('https://www.linkedin.com/jobs/search/');
    url.searchParams.set('keywords', queryTerms(task)); url.searchParams.set('location', 'Worldwide');
    if (task.filters?.remote) url.searchParams.set('f_WT', '2');
    if (task.filters?.seniority === 'senior') url.searchParams.set('f_E', '4');
    return url.toString();
  }
  get selectors() {
    return { card: '.job-card-container, [data-job-id], .jobs-search-results__list-item, .job-search-card', link: 'a[href*="/jobs/view/"]', title: '.job-card-list__title--link, .job-card-list__title, .base-search-card__title', company: '.job-card-container__primary-description, .base-search-card__subtitle', location: '.job-card-container__metadata-item, .job-search-card__location', description: '.job-card-list__snippet', modality: '.job-card-container__metadata-item' };
  }
  parse(record) {
    const id = String(record.url || '').match(/\/jobs\/view\/(\d+)/)?.[1] || '';
    return commonJob(record, { source: this.id, baseUrl: 'https://www.linkedin.com', allowedHosts: ['linkedin.com'], externalId: id });
  }
}

export class IndeedDiscoverySourceAdapter {
  constructor() { this.id = 'indeed'; this.version = '1'; }
  buildSearchUrl(task) {
    const url = new URL('https://mx.indeed.com/jobs');
    url.searchParams.set('q', queryTerms(task));
    url.searchParams.set('l', task.filters?.markets?.includes('LATAM') ? 'Remote' : '');
    if (task.filters?.remote) url.searchParams.set('sc', '0kf:attr(DSQF7);');
    return url.toString();
  }
  get selectors() {
    return { card: '.job_seen_beacon, [data-jk]', link: 'a[href*="/viewjob"], a[data-jk]', title: '[data-testid="jobTitle"], .jobTitle', company: '[data-testid="company-name"], .companyName', location: '[data-testid="text-location"], .companyLocation', description: '.underShelfFooter, .job-snippet', modality: '.metadata' };
  }
  parse(record) {
    let id = ''; try { id = new URL(record.url, 'https://mx.indeed.com').searchParams.get('jk') || ''; } catch {}
    return commonJob(record, { source: this.id, baseUrl: 'https://mx.indeed.com', allowedHosts: ['indeed.com'], externalId: id });
  }
}

export class OccDiscoverySourceAdapter {
  constructor() { this.id = 'occ'; this.version = '1'; }
  buildSearchUrl(task) {
    const url = new URL('https://www.occ.com.mx/empleos/');
    url.searchParams.set('q', queryTerms(task));
    if (task.filters?.remote) url.searchParams.set('modalidad', 'remoto');
    return url.toString();
  }
  get selectors() {
    return { card: '[data-testid="job-card"], article, .job-card', link: 'a[href*="/empleo/oferta/"]', title: '[data-testid="job-title"], h2, h3', company: '[data-testid="company-name"], .company', location: '[data-testid="job-location"], .location', description: '.description, .snippet', modality: '.work-mode, .modality' };
  }
  parse(record) {
    const id = String(record.url || '').match(/\/empleo\/oferta\/([^/?#]+)/)?.[1] || '';
    return commonJob(record, { source: this.id, baseUrl: 'https://www.occ.com.mx', allowedHosts: ['occ.com.mx'], externalId: id });
  }
}

export function browserDiscoverySourceAdapters() {
  return new Map([
    ['linkedin', new LinkedInDiscoverySourceAdapter()],
    ['indeed', new IndeedDiscoverySourceAdapter()],
    ['occ', new OccDiscoverySourceAdapter()],
  ]);
}
