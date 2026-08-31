import { rankOperationalCandidates } from './operational-loop.mjs';
import { GoogleSheetsApiAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { syncSourceMetricsSheet } from '../human-control-plane/source-metrics.mjs';
import { runBrowserDiscovery } from '../research/discovery-runner.mjs';
import { createGoogleOAuthTokenProviderFromEnv, inspectGoogleOAuthConfig } from '../operations/google-oauth.mjs';

export async function runBrowserDiscoveryWindow({
  registry, discoveryOptions,
  profilePath = process.env.CAREER_OPS_PROFILE || 'config/profile.yml',
  portalsPath = process.env.CAREER_OPS_PORTALS || 'portals.yml', clock = () => new Date(),
  spreadsheetId = process.env.CAREER_OPS_SHEET_ID || '', tokenProvider = null, env = process.env,
  sheetAdapter = null, discoveryStage = runBrowserDiscovery,
  rankingStage = rankOperationalCandidates, sourceMetricsStage = syncSourceMetricsSheet,
} = {}) {
  if (!registry) throw new TypeError('registry is required');
  const errors = [];
  const discovery = await discoveryStage({ registry, clock, ...discoveryOptions });
  let ranking = { processed: 0, eligible: 0, shortlisted: 0, shortlistedJobIds: [], recommendations: [] };
  if (discovery.status !== 'FAILED') {
    try { ranking = await rankingStage({ registry, discoveryRunId: discovery.run.id, profilePath, portalsPath, clock }); }
    catch (error) { errors.push({ stage: 'ranking', code: error.code || 'BROWSER_DISCOVERY_RANKING_FAILED', message: error.message }); }
  }
  const runMetrics = registry.getBrowserDiscoveryMetrics(discovery.run.id);
  const strategyMetrics = registry.getBrowserDiscoveryStrategyMetrics?.(discovery.run.id) || [];
  const providerPerformance = registry.getProviderPerformance();
  let sheet = { synced: false, reason: 'SOURCE_METRICS_NOT_CONFIGURED', rows: 0 };
  if (spreadsheetId && (sheetAdapter || inspectGoogleOAuthConfig({ env }).ok)) {
    try {
      const adapter = sheetAdapter || new GoogleSheetsApiAdapter({ spreadsheetId, tokenProvider: tokenProvider || createGoogleOAuthTokenProviderFromEnv({ env }) });
      sheet = await sourceMetricsStage({ adapter, metrics: [
        ...providerPerformance.map(item => ({ ...item, scope: 'LIFETIME', strategy: 'ALL' })),
        ...strategyMetrics.map(item => ({ ...item, scope: 'RUN' })),
      ] });
    } catch (error) { errors.push({ stage: 'source-metrics-sheet', code: error.code || 'SOURCE_METRICS_SYNC_FAILED', message: error.message }); sheet = { synced: false, reason: 'SOURCE_METRICS_SYNC_FAILED', rows: 0 }; }
  }
  const status = discovery.status === 'FAILED' ? 'FAILED' : discovery.status === 'PARTIAL' || errors.length ? 'PARTIAL' : 'SUCCESS';
  return {
    status, exitCode: status === 'SUCCESS' ? 0 : status === 'PARTIAL' ? 2 : 1,
    discovery, ranking, runMetrics, strategyMetrics, providerPerformance, sheet, errors,
    automaticDailyIntegration: false,
  };
}
