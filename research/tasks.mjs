export const DEFAULT_JOB_QUERIES = Object.freeze(['AI Systems Engineer', 'AI Platform Engineer', 'Senior Data Engineer']);
export const DEFAULT_MARKETS = Object.freeze(['Remote contractor', 'LATAM global']);
export const DEFAULT_RESEARCH_SOURCES = Object.freeze(['linkedin', 'indeed', 'occ', 'facebook']);

export function buildResearchTasks({ config = {}, companies = [] } = {}) {
  const sources = config.sources || []; const sourceById = new Map(sources.map(item => [item.id, item]));
  const selected = config.enabledSources || DEFAULT_RESEARCH_SOURCES; const tasks = [];
  for (const sourceId of selected) {
    const source = sourceById.get(sourceId); if (!source?.searchUrlTemplate) continue;
    for (const query of config.jobQueries || DEFAULT_JOB_QUERIES) for (const market of config.markets || DEFAULT_MARKETS) {
      const url = source.searchUrlTemplate.replaceAll('{query}', encodeURIComponent(query)).replaceAll('{market}', encodeURIComponent(market));
      tasks.push({ id: `job:${sourceId}:${query}:${market}`, kind: 'JOB_DISCOVERY', source: sourceId, query, market, url });
    }
  }
  for (const company of companies.slice(0, config.companyLimit || 20)) for (const kind of ['COMPANY_RESEARCH', 'CONTACT_RESEARCH']) {
    const source = sourceById.get(config.companySource || 'web'); if (!source?.searchUrlTemplate) continue;
    const query = kind === 'COMPANY_RESEARCH' ? `${company} careers hiring team` : `${company} recruiter hiring manager engineering lead`;
    tasks.push({ id: `${kind.toLowerCase()}:${company}`, kind, source: source.id, company, query, url: source.searchUrlTemplate.replaceAll('{query}', encodeURIComponent(query)).replaceAll('{market}', '') });
  }
  return tasks;
}
