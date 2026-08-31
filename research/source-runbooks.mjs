const COMMON_BUDGET = Object.freeze({ navigationMs: 30_000, readinessMs: 15_000, pollMs: 500,
  maxScrollPasses: 5, maxScrollMs: 12_000, stablePasses: 2, maxCards: 25, maxDetails: 5, maxTaskMs: 60_000 });

export const BROWSER_RUNBOOK_VERSION = '1.0';

const RUNBOOKS = Object.freeze({
  linkedin_feed: {
    id: 'linkedin_feed', source: 'linkedin', mode: 'personalized_feed', expectedHosts: ['linkedin.com'],
    expectedUrlPattern: '/jobs/(collections|recommended)', selectorsVersion: 'linkedin-2026-08-v2',
    selectors: {
      card: ['.job-card-container', '[data-job-id]', '.jobs-search-results__list-item', '.job-search-card'],
      link: ['a[href*="/jobs/view/"]'], title: ['.job-card-list__title', '.job-card-container__link', '.base-search-card__title'],
      company: ['.job-card-container__primary-description', '.base-search-card__subtitle'],
      location: ['.job-card-container__metadata-item', '.job-search-card__location'],
      description: ['.job-card-list__snippet'],
    }, requireScrollForSuccess: true, ...COMMON_BUDGET,
  },
  linkedin_search: {
    id: 'linkedin_search', source: 'linkedin', mode: 'targeted_search', expectedHosts: ['linkedin.com'],
    expectedUrlPattern: '/jobs/search', selectorsVersion: 'linkedin-2026-08-v2',
    selectors: {
      card: ['.job-card-container', '[data-job-id]', '.jobs-search-results__list-item', '.job-search-card'], link: ['a[href*="/jobs/view/"]'],
      title: ['.job-card-list__title', '.job-card-container__link', '.base-search-card__title'],
      company: ['.job-card-container__primary-description', '.base-search-card__subtitle'],
      location: ['.job-card-container__metadata-item', '.job-search-card__location'], description: ['.job-card-list__snippet'],
    }, confirmQuery: true, ...COMMON_BUDGET,
  },
  indeed_search: {
    id: 'indeed_search', source: 'indeed', mode: 'targeted_search', expectedHosts: ['indeed.com'],
    expectedUrlPattern: '/jobs', selectorsVersion: 'indeed-2026-08-v1',
    recommendations: 'not_supported',
    selectors: { card: ['.job_seen_beacon', '[data-jk]'], link: ['a[href*="/viewjob"]', 'a[data-jk]'],
      title: ['[data-testid="jobTitle"]', '.jobTitle'], company: ['[data-testid="company-name"]', '.companyName'],
      location: ['[data-testid="text-location"]', '.companyLocation'], description: ['.job-snippet', '.underShelfFooter'] },
    confirmQuery: true, ...COMMON_BUDGET,
  },
  occ_search: {
    id: 'occ_search', source: 'occ', mode: 'targeted_search', expectedHosts: ['occ.com.mx'],
    expectedUrlPattern: '/empleos', selectorsVersion: 'occ-2026-08-v1',
    selectors: { card: ['[data-testid="job-card"]', 'article.job-card', '.job-card'], link: ['a[href*="/empleo/oferta/"]'],
      title: ['[data-testid="job-title"]', 'h2', 'h3'], company: ['[data-testid="company-name"]', '.company'],
      location: ['[data-testid="job-location"]', '.location'], description: ['.description', '.snippet'] },
    confirmQuery: true, ...COMMON_BUDGET,
  },
  enrichment: {
    id: 'enrichment', source: 'web', mode: 'enrichment', expectedHosts: [], selectorsVersion: 'detail-generic-2026-08-v1',
    selectors: { card: ['main', 'article', '[role="main"]'], link: ['link[rel="canonical"]', 'a[href]'],
      title: ['h1', '[data-testid*="title"]'], company: ['[data-testid*="company"]'], location: ['[data-testid*="location"]'],
      description: ['[data-testid*="description"]', '.description', 'article', 'main'] },
    ...COMMON_BUDGET, maxScrollPasses: 1, stablePasses: 1, maxDetails: 1, maxCards: 1,
  },
});

export function browserRunbookForTask(task, overrides = {}) {
  const key = task.mode === 'personalized_feed' ? 'linkedin_feed'
    : task.mode === 'enrichment' || task.type === 'CANDIDATE_ENRICHMENT' ? 'enrichment'
      : `${task.source}_search`;
  const base = RUNBOOKS[key];
  if (!base) throw new TypeError(`no browser runbook for ${key}`);
  return { ...base, ...overrides, selectors: { ...base.selectors, ...(overrides.selectors || {}) } };
}

export function listBrowserRunbooks() { return Object.values(RUNBOOKS).map(item => structuredClone(item)); }
