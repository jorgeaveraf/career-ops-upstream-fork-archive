import { randomUUID } from 'crypto';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from '../registry/job-registry.mjs';
import { toRegistryJobObservation } from './browser-research-provider.mjs';
import { BROWSER_RESEARCH_PROVENANCE_MODE } from './browser-policy.mjs';

export const BROWSER_RESEARCH_EXIT_CODES = Object.freeze({ SUCCESS: 0, FAILED: 1, PARTIAL: 2 });

export async function runBrowserResearch({
  registry: suppliedRegistry = null, dbPath = process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH,
  sessionManager, selection = null, selectionResolver = null, provider, tasks = [], runId = randomUUID(), clock = () => new Date(),
} = {}) {
  if (!sessionManager || (!selection && !selectionResolver) || !provider) throw new TypeError('sessionManager, selection or selectionResolver, and provider are required');
  const registry = suppliedRegistry || openJobRegistry({ dbPath, clock }); const ownsRegistry = !suppliedRegistry;
  registry.startRun({ id: runId, type: 'browser-research', startedAt: clock().toISOString(), metadata: { orchestrator: 'browser-research', mode: BROWSER_RESEARCH_PROVENANCE_MODE, profile: selection?.profile || 'unresolved' } });
  let session = null; let status = 'FAILED';
  let result = { observations: [], failures: [], pages: 0 }; let persisted = []; let jobs = [];
  try {
    try {
      const resolvedSelection = selection || selectionResolver();
      session = await sessionManager.acquire(resolvedSelection);
    }
    catch (error) {
      registry.recordRunFailure(runId, { provider: 'browser-research', code: error.code || 'BROWSER_UNAVAILABLE', message: error.message, retryable: true });
      const summary = registry.finishRun(runId, { status: 'FAILED', finishedAt: clock().toISOString() });
      return { status: 'FAILED', exitCode: 1, run: summary, browser: { pages: 0, observations: 0, newEvidence: 0, duplicateEvidence: 0, jobs: 0 }, failures: summary.failureDetails };
    }
    await provider.adapter.start?.(session);
    result = await provider.research({ tasks, session, runId });
    persisted = registry.recordBrowserResearchResults(runId, result.observations);
    const jobObservations = result.observations.map(toRegistryJobObservation).filter(Boolean);
    jobs = jobObservations.length ? registry.recordObservations(runId, jobObservations) : [];
    for (const failure of result.failures) registry.recordRunFailure(runId, { provider: 'browser-research', target: failure.taskId, code: failure.code, message: failure.message, retryable: true });
    status = result.failures.length ? 'PARTIAL' : 'SUCCESS';
    const summary = registry.finishRun(runId, { status, finishedAt: clock().toISOString(), metadata: { pages: result.pages, evidence: persisted.length, jobs: jobs.length } });
    return {
      status, exitCode: BROWSER_RESEARCH_EXIT_CODES[status], run: summary,
      browser: {
        pages: result.pages, observations: persisted.length,
        newEvidence: persisted.filter(item => item.outcome === 'NEW').length,
        duplicateEvidence: persisted.filter(item => item.outcome === 'DUPLICATE').length,
        jobs: jobs.length,
      },
      failures: summary.failureDetails,
    };
  } catch (error) {
    registry.recordRunFailure(runId, { provider: 'browser-research', code: error.code || 'BROWSER_RESEARCH_FAILED', message: error.message, retryable: false });
    const summary = registry.finishRun(runId, { status: 'FAILED', finishedAt: clock().toISOString() });
    return { status: 'FAILED', exitCode: 1, run: summary, browser: { pages: result.pages, observations: persisted.length, newEvidence: 0, duplicateEvidence: 0, jobs: jobs.length }, failures: summary.failureDetails };
  } finally {
    try { await provider.adapter.close?.(); } catch {}
    if (session) await sessionManager.release(session);
    if (ownsRegistry) registry.close();
  }
}

function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function shouldRunBrowserResearchScheduled({ registry, now = new Date(), timeZone = 'America/Mexico_City', hour = 16, minute = 0 } = {}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
  if (Number(parts.hour) * 60 + Number(parts.minute) < Number(hour) * 60 + Number(minute)) return { run: false, reason: 'BEFORE_RESEARCH_WINDOW' };
  const latest = registry.getLatestRunByType('browser-research');
  if (latest && localDate(new Date(latest.started_at), timeZone) === localDate(now, timeZone)) return { run: false, reason: 'BROWSER_RESEARCH_ALREADY_RAN', runId: latest.id, status: latest.status };
  return { run: true, reason: 'DUE' };
}

export function shouldRunBrowserDiscoveryScheduled({ registry, enabled = true, now = new Date(), timeZone = 'America/Mexico_City', hour = 16, minute = 0 } = {}) {
  if (!enabled) return { run: false, reason: 'BROWSER_DISCOVERY_DISABLED' };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
  if (Number(parts.hour) * 60 + Number(parts.minute) < Number(hour) * 60 + Number(minute)) return { run: false, reason: 'BEFORE_DISCOVERY_WINDOW' };
  const latest = registry.getLatestRunByType('browser-discovery');
  if (latest && localDate(new Date(latest.started_at), timeZone) === localDate(now, timeZone)) return { run: false, reason: 'BROWSER_DISCOVERY_ALREADY_RAN', runId: latest.id, status: latest.status };
  return { run: true, reason: 'DUE' };
}
