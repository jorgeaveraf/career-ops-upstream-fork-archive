import { readFileSync } from 'fs';
import path from 'path';

export function loadBrowserResearchConfig(file = process.env.BROWSER_RESEARCH_CONFIG || 'config/browser-research.json') {
  const absolute = path.resolve(file); let config;
  try { config = JSON.parse(readFileSync(absolute, 'utf8')); }
  catch (error) { const wrapped = new Error(`cannot load Browser Research config ${absolute}: ${error.message}`); wrapped.code = 'BROWSER_CONFIG_UNAVAILABLE'; throw wrapped; }
  if (!Array.isArray(config.sources) || !config.sources.length) throw new TypeError('browser research config requires sources');
  for (const source of config.sources) {
    if (!source.id || !source.searchUrlTemplate) throw new TypeError('each browser research source requires id and searchUrlTemplate');
    if (!String(source.searchUrlTemplate).startsWith('https://')) throw new TypeError(`browser research source ${source.id} must use HTTPS`);
  }
  const discovery = config.browser_discovery;
  if (discovery != null) {
    if (typeof discovery !== 'object' || Array.isArray(discovery)) throw new TypeError('browser_discovery must be an object');
    if (discovery.enabled != null && typeof discovery.enabled !== 'boolean') throw new TypeError('browser_discovery.enabled must be boolean');
    if (discovery.useDiscoveryStrategy != null && typeof discovery.useDiscoveryStrategy !== 'boolean') throw new TypeError('browser_discovery.useDiscoveryStrategy must be boolean');
    if (discovery.queries != null && (!Array.isArray(discovery.queries) || !discovery.queries.length || discovery.queries.some(query => !String(query || '').trim()))) throw new TypeError('browser_discovery.queries must contain non-empty strings');
    if (discovery.sources != null && (typeof discovery.sources !== 'object' || Array.isArray(discovery.sources))) throw new TypeError('browser_discovery.sources must be an object');
    for (const [source, sourceConfig] of Object.entries(discovery.sources || {})) {
      if (!['linkedin', 'indeed', 'occ', 'facebook'].includes(source)) throw new TypeError(`unsupported browser discovery source: ${source}`);
      if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) throw new TypeError(`browser_discovery.sources.${source} must be an object`);
      if (sourceConfig.enabled != null && typeof sourceConfig.enabled !== 'boolean') throw new TypeError(`browser_discovery.sources.${source}.enabled must be boolean`);
      if (sourceConfig.queries != null && (!Array.isArray(sourceConfig.queries) || !sourceConfig.queries.length || sourceConfig.queries.some(query => !String(query || '').trim()))) throw new TypeError(`browser_discovery.sources.${source}.queries must contain non-empty strings`);
    }
  }
  for (const [section, execution] of [['browser_execution', config.browser_execution], ['browser_enrichment', config.browser_enrichment]]) {
    if (execution == null) continue;
    if (typeof execution !== 'object' || Array.isArray(execution)) throw new TypeError(`${section} must be an object`);
    for (const key of ['navigationMs','readinessMs','pollMs','maxScrollPasses','maxScrollMs','stablePasses','maxCards','maxDetails','maxTaskMs','maxTasks','maxTotalTasks','maxTasksPerSource','maxWindowMs']) {
      if (execution[key] != null && (!Number.isInteger(Number(execution[key])) || Number(execution[key]) < 0)) throw new TypeError(`${section}.${key} must be a non-negative integer`);
    }
  }
  return config;
}
