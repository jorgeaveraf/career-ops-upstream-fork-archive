import { randomUUID } from 'crypto';
import { toNormalizedObservation } from '../acquisition/provider-adapter.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from '../registry/job-registry.mjs';
import { BrowserJobSearchProvider } from './browser-job-search-provider.mjs';
import { evaluateDiscoveryCandidate } from '../discovery-strategy/rules.mjs';
import { BROWSER_RESEARCH_PROVENANCE_MODE } from './browser-policy.mjs';

export async function runBrowserDiscovery({
  registry: suppliedRegistry = null, dbPath = process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH,
  sessionManager, selection = null, selectionResolver = null, browserAdapter,
  sourceAdapters, tasks = [], strategy = null, runId = randomUUID(), clock = () => new Date(), onTask = null,
} = {}) {
  if (!sessionManager || (!selection && !selectionResolver) || !browserAdapter || !sourceAdapters) throw new TypeError('Browser Discovery dependencies are required');
  const registry = suppliedRegistry || openJobRegistry({ dbPath, clock }); const ownsRegistry = !suppliedRegistry;
  registry.startRun({ id: runId, type: 'browser-discovery', startedAt: clock().toISOString(), metadata: { orchestrator: 'browser-discovery', mode: BROWSER_RESEARCH_PROVENANCE_MODE, profile: selection?.profile || 'unresolved' } });
  let session = null; const aggregates = new Map(); const failures = [];
  const lastFingerprintBySource = new Map();
  try {
    try { session = await sessionManager.acquire(selection || selectionResolver()); }
    catch (error) {
      registry.recordRunFailure(runId, { provider: 'browser-discovery', code: error.code || 'BROWSER_UNAVAILABLE', message: error.message, retryable: true });
      const run = registry.finishRun(runId, { status: 'FAILED', finishedAt: clock().toISOString() });
      return { status: 'FAILED', exitCode: 1, run, providers: [], failures: run.failureDetails };
    }
    await browserAdapter.start?.(session);
    for (const task of tasks) {
      const startedAt = clock().toISOString(); const sourceAdapter = sourceAdapters.get(task.source);
      const provider = new BrowserJobSearchProvider({ sourceAdapter, browserAdapter, clock });
      const result = await provider.acquire(task, { session }, { runId, retrievedAt: startedAt });
      if (result.telemetry) {
        const fingerprint = result.telemetry.scrollPasses?.at(-1)?.fingerprint || '';
        const previous = lastFingerprintBySource.get(task.source);
        if (fingerprint && previous?.fingerprint === fingerprint && previous.query !== task.query) {
          result.telemetry.warnings.push(`REPEATED_RESULT_SET:query=${previous.query}`);
        }
        if (fingerprint) lastFingerprintBySource.set(task.source, { fingerprint, query: task.query });
        registry.recordBrowserTaskTelemetry?.(runId, result.telemetry, { mode: 'DISCOVERY' });
      }
      const current = aggregates.get(provider.id) || { provider: provider.id, discovered: 0, valid: 0, duplicates: 0 };
      current.discovered += result.metrics?.discovered || 0; current.valid += result.data?.length || 0;
      if (result.ok) {
        const evaluated = result.data.map(job => ({ job, decision: strategy ? evaluateDiscoveryCandidate(job, strategy) : { accepted: true, hardReject: false, priorityAdjustment: 0, reasons: [] } }));
        const rejected = evaluated.filter(item => !item.decision.accepted);
        const rejectedCount = rejected.length + (result.metrics?.invalid || 0);
        const observations = evaluated.filter(item => item.decision.accepted).map(({ job, decision }) => toNormalizedObservation({
          ...job,
          rawMetadata: {
            ...(job.rawMetadata || {}),
            discoveryStrategy: {
              strategyId: task.strategyId || `${task.source}_search`, mode: task.mode || 'targeted_search',
              explanation: task.explanation || {}, priorityAdjustment: decision.priorityAdjustment,
              poolSignals: decision.pool?.matched || [], compensationState: decision.compensation?.state || 'UNKNOWN',
            },
          },
        }, { providerId: provider.id, runId }));
        const outcomes = observations.length ? registry.recordObservations(runId, observations) : [];
        const duplicateCount = outcomes.filter(item => item.outcome === 'DUPLICATE_OBSERVATION').length;
        current.duplicates += duplicateCount;
        registry.recordProviderResult(runId, { provider: provider.id, target: task.query, status: 'SUCCESS', observations: observations.length, startedAt, finishedAt: clock().toISOString() });
        registry.recordBrowserDiscoveryTaskResult?.(runId, {
          taskId: task.id, provider: provider.id, strategyId: task.strategyId || `${task.source}_search`, query: task.query,
          status: 'SUCCESS', discovered: result.metrics?.discovered || 0, valid: result.data.length,
          rejected: rejectedCount, duplicates: duplicateCount, explanation: { ...(task.explanation || {}), rejectionReasons: result.metrics?.rejectionReasons || {} }, startedAt, finishedAt: clock().toISOString(),
        }, outcomes);
        onTask?.({ task, provider: provider.id, status: result.telemetry?.outcome || 'SUCCESS_RESULTS', durationMs: new Date(clock()).getTime() - new Date(startedAt).getTime(), discovered: result.metrics?.discovered || 0, valid: result.data.length, accepted: observations.length, rejected: rejectedCount, duplicates: duplicateCount, warnings: [...(result.warnings || []), ...(result.telemetry?.warnings || [])] });
      } else {
        const failure = { provider: provider.id, target: task.query, code: result.error.code, message: result.error.safeMessage };
        failures.push(failure); registry.recordRunFailure(runId, { ...failure, retryable: result.error.retryable });
        registry.recordProviderResult(runId, { provider: provider.id, target: task.query, status: 'FAILED', errorCode: failure.code, errorMessage: failure.message, startedAt, finishedAt: clock().toISOString() });
        registry.recordBrowserDiscoveryTaskResult?.(runId, {
          taskId: task.id, provider: provider.id, strategyId: task.strategyId || `${task.source}_search`, query: task.query,
          status: 'FAILED', discovered: 0, valid: 0, rejected: 0, duplicates: 0,
          explanation: task.explanation || {}, errorCode: failure.code, errorMessage: failure.message,
          startedAt, finishedAt: clock().toISOString(),
        });
        onTask?.({ task, provider: provider.id, status: 'FAILED', durationMs: new Date(clock()).getTime() - new Date(startedAt).getTime(), error: failure });
      }
      aggregates.set(provider.id, current);
    }
    registry.recordBrowserDiscoveryMetrics(runId, [...aggregates.values()]);
    const status = failures.length === tasks.length && tasks.length ? 'FAILED' : failures.length ? 'PARTIAL' : 'SUCCESS';
    const run = registry.finishRun(runId, { status, finishedAt: clock().toISOString(), metadata: { mode: BROWSER_RESEARCH_PROVENANCE_MODE, taskCount: tasks.length, automaticDailyIntegration: false } });
    return { status, exitCode: status === 'SUCCESS' ? 0 : status === 'PARTIAL' ? 2 : 1, run, providers: registry.getBrowserDiscoveryMetrics(runId), failures: run.failureDetails };
  } catch (error) {
    registry.recordRunFailure(runId, { provider: 'browser-discovery', code: error.code || 'BROWSER_DISCOVERY_FAILED', message: error.message, retryable: false });
    const run = registry.finishRun(runId, { status: 'FAILED', finishedAt: clock().toISOString() });
    return { status: 'FAILED', exitCode: 1, run, providers: registry.getBrowserDiscoveryMetrics(runId), failures: run.failureDetails };
  } finally {
    try { await browserAdapter.close?.(); } catch {}
    if (session) await sessionManager.release(session);
    if (ownsRegistry) registry.close();
  }
}
