export function withProviderQualityMetrics(metrics = {}) {
  const discovered = Number(metrics.discovered) || 0;
  const shortlist = Number(metrics.shortlist) || 0;
  const packagesReady = Number(metrics.packagesReady ?? metrics.packages) || 0;
  return {
    ...metrics,
    providerRoi: discovered ? shortlist / discovered : 0,
    evaluationRoi: discovered ? packagesReady / discovered : 0,
  };
}
