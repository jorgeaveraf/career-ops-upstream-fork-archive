export const BROWSER_DISCOVERY_SOURCES = Object.freeze(['linkedin', 'indeed', 'occ']);
export const BROWSER_DISCOVERY_QUERIES = Object.freeze([
  'AI Systems Engineer', 'AI Platform Engineer', 'Senior AI Engineer',
  'Data Engineer', 'Solutions Architect',
]);
export const DEFAULT_DISCOVERY_FILTERS = Object.freeze({
  remote: true, seniority: 'senior', contractor: 'preferred', technology: true,
  markets: ['LATAM', 'global'],
});

function boundedTasks(tasks, execution = {}) {
  const total = Math.max(1, Number.parseInt(execution.maxTotalTasks, 10) || tasks.length || 1);
  const perSource = Math.max(1, Number.parseInt(execution.maxTasksPerSource, 10) || tasks.length || 1);
  const counts = new Map(); const selected = [];
  for (const task of tasks) {
    if (selected.length >= total) break;
    if ((counts.get(task.source) || 0) >= perSource) continue;
    selected.push(task); counts.set(task.source, (counts.get(task.source) || 0) + 1);
  }
  return selected;
}

export function buildBrowserDiscoveryTasks({ config = {}, adapters, strategyTasks = null } = {}) {
  const discovery = config.browser_discovery || config.discovery || {};
  if (discovery.enabled === false) return [];
  const configuredSources = discovery.sources && !Array.isArray(discovery.sources) ? discovery.sources : null;
  const enabled = configuredSources
    ? Object.entries(configuredSources).filter(([, value]) => value?.enabled !== false).map(([source]) => source)
    : discovery.enabledSources || BROWSER_DISCOVERY_SOURCES;
  const globalQueries = discovery.queries || discovery.jobQueries || BROWSER_DISCOVERY_QUERIES;
  const globalFilters = { ...DEFAULT_DISCOVERY_FILTERS, ...(discovery.filters || {}) };
  const globalMaxResults = Math.max(1, Math.min(50, Number.parseInt(discovery.maxResultsPerTask, 10) || 10));
  const executionBudget = { ...(config.browser_execution || {}), ...(discovery.executionBudget || {}) };
  if (Array.isArray(strategyTasks)) {
    const generated = strategyTasks.filter(task => task.execution === 'browser_discovery').filter(task => {
      if (!configuredSources) return true;
      return Object.hasOwn(configuredSources, task.source) && configuredSources[task.source]?.enabled !== false;
    }).map(task => {
      const adapter = adapters?.get?.(task.source) || adapters?.[task.source];
      if (!adapter) throw new TypeError(`unsupported Browser Discovery source: ${task.source}`);
      const sourceConfig = configuredSources?.[task.source] || {};
      const filters = { ...globalFilters, ...(task.filters || {}), ...(sourceConfig.filters || {}) };
      const maxResults = Math.max(1, Math.min(50, Number.parseInt(sourceConfig.maxResultsPerTask, 10) || globalMaxResults));
      return { ...task, filters, maxResults, executionBudget: { ...executionBudget, ...(sourceConfig.executionBudget || {}) }, url: adapter.buildSearchUrl({ ...task, filters }) };
    });
    return boundedTasks(generated, executionBudget);
  }
  const tasks = [];
  for (const source of enabled) {
    if (source === 'facebook') continue;
    const adapter = adapters?.get?.(source) || adapters?.[source];
    if (!adapter) throw new TypeError(`unsupported Browser Discovery source: ${source}`);
    const sourceConfig = configuredSources?.[source] || {};
    const queries = sourceConfig.queries?.length ? sourceConfig.queries : globalQueries;
    const filters = { ...globalFilters, ...(sourceConfig.filters || {}) };
    const maxResults = Math.max(1, Math.min(50, Number.parseInt(sourceConfig.maxResultsPerTask, 10) || globalMaxResults));
    for (const query of queries) {
      const task = { type: 'JOB_DISCOVERY', source, query, filters: structuredClone(filters) };
      tasks.push({ ...task, maxResults, executionBudget: { ...executionBudget, ...(sourceConfig.executionBudget || {}) }, id: `browser-discovery:${source}:${query}`, url: adapter.buildSearchUrl(task) });
    }
  }
  return boundedTasks(tasks, executionBudget);
}
