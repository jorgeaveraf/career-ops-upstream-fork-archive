import { rowsToMatrix } from './projection.mjs';

export function buildSourceMetricsRows(metrics = []) {
  return metrics.map(item => ({
    Scope: item.scope || (item.strategy ? 'RUN' : 'LIFETIME'),
    Source: item.provider || item.source,
    Strategy: item.strategy || 'ALL',
    Discovered: item.discovered,
    Valid: item.valid,
    Duplicates: item.duplicates,
    Eligible: item.eligible,
    Shortlist: item.shortlist,
    Evaluated: item.evaluations,
    'Pipeline Admitted': item.pipelineAdmitted ?? 0,
    'TODAY Promoted': item.todayPromoted ?? 0,
    Applied: item.applied ?? 0,
    'Package Ready': item.packagesReady ?? item.packages ?? 0,
    'Provider ROI': item.providerRoi,
    'Evaluation ROI': item.evaluationRoi,
    'Last Run': item.lastRun || item.recordedAt || '',
    'Metric ID': `${item.scope || (item.strategy ? 'RUN' : 'LIFETIME')}|${item.provider || item.source}|${item.strategy || 'ALL'}`,
  }));
}

export async function syncSourceMetricsSheet({ adapter, metrics = [] } = {}) {
  if (!adapter) return { synced: false, reason: 'SOURCE_METRICS_ADAPTER_UNAVAILABLE', rows: 0 };
  const rows = buildSourceMetricsRows(metrics);
  await adapter.initialize({ optionalTabs: ['SOURCE_METRICS'], includeCore: false });
  await adapter.writeTab('SOURCE_METRICS', rowsToMatrix('SOURCE_METRICS', rows));
  return { synced: true, tab: 'SOURCE_METRICS', rows: rows.length };
}
