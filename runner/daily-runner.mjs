import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { openJobRegistry, DEFAULT_REGISTRY_PATH } from '../registry/job-registry.mjs';
import {
  acquireDailyLock,
  DEFAULT_DAILY_LOCK_PATH,
  DEFAULT_STALE_AFTER_MS,
  heartbeatDailyLock,
  isProcessAlive,
  releaseDailyLock,
} from './daily-lock.mjs';

export const DAILY_EXIT_CODES = Object.freeze({ SUCCESS: 0, FAILED: 1, PARTIAL: 2 });
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function isoNow(clock) {
  return clock().toISOString();
}

export function executeScanner({ runId, dbPath, cwd = process.cwd(), env = process.env, scannerStdio = ['ignore', 'inherit', 'inherit'] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scan.mjs')], {
      cwd,
      env: {
        ...env,
        CAREER_OPS_DB: dbPath,
        CAREER_OPS_RUN_ID: runId,
        CAREER_OPS_RUN_TYPE: 'daily',
        CAREER_OPS_MANAGED_RUN: '1',
      },
      stdio: scannerStdio,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ code: 0 });
      else reject(new Error(signal ? `scanner terminated by ${signal}` : `scanner exited with code ${code}`));
    });
  });
}

export function buildDailySummary(runSummary, { recoveredRuns = [] } = {}) {
  if (!runSummary) return null;
  const providerMap = new Map();
  for (const item of runSummary.providerResults || []) {
    const current = providerMap.get(item.provider) || {
      provider: item.provider, status: 'SUCCESS', targets: 0, observations: 0, failures: 0,
    };
    current.targets++;
    current.observations += item.observations || 0;
    if (item.errorCode === 'OPTIONAL_UNAVAILABLE') current.status = 'OPTIONAL_UNAVAILABLE';
    if (item.status === 'FAILED') {
      current.status = 'FAILED';
      current.failures++;
    }
    providerMap.set(item.provider, current);
  }
  return {
    run: {
      id: runSummary.id,
      type: runSummary.type,
      status: runSummary.status,
      createdAt: runSummary.createdAt,
      startedAt: runSummary.startedAt,
      finishedAt: runSummary.finishedAt,
      durationMs: runSummary.durationMs,
    },
    discovery: {
      observations: runSummary.observations,
      newJobs: runSummary.newJobs,
      changedJobs: runSummary.changedJobs,
      knownJobs: runSummary.knownJobs,
      duplicateObservations: runSummary.duplicateObservations,
    },
    providers: [...providerMap.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    failures: (runSummary.failureDetails || []).map(item => ({
      provider: item.provider,
      target: item.target,
      code: item.code,
      message: item.message,
      retryable: item.retryable,
      recordedAt: item.recordedAt,
    })),
    recovery: {
      interruptedRunIds: recoveredRuns.map(run => run.id).sort(),
    },
  };
}

function dryRunResult({ dbPath, lockPath }) {
  return {
    dryRun: true,
    status: 'SUCCESS',
    exitCode: DAILY_EXIT_CODES.SUCCESS,
    plan: [
      `would acquire lock at ${path.resolve(lockPath)}`,
      'would recover abandoned RUNNING runs',
      'would create and start a daily run',
      'would execute scan.mjs as the discovery engine',
      `would persist through JobRegistry at ${path.resolve(dbPath)}`,
      'would finalize and return a structured summary',
    ],
    skipped: ['lock writes', 'database writes', 'scanner execution', 'Markdown/TSV writes', 'external actions'],
  };
}

function errorDetails(error) {
  return error ? { name: error.name || 'Error', code: error.code || null, message: error.message || String(error) } : null;
}

export async function runDaily({
  dryRun = false,
  dbPath = process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH,
  lockPath = process.env.CAREER_OPS_DAILY_LOCK || DEFAULT_DAILY_LOCK_PATH,
  discoveryExecutor = executeScanner,
  clock = () => new Date(),
  pid = process.pid,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  processAlive = isProcessAlive,
  heartbeatIntervalMs = 30_000,
  cwd = process.cwd(),
  env = process.env,
  scannerStdio,
  runId = randomUUID(),
} = {}) {
  if (dryRun) return dryRunResult({ dbPath, lockPath });

  let lock = null;
  let registry = null;
  let heartbeatTimer = null;
  let recoveredRuns = [];
  let runCreated = false;
  try {
    lock = acquireDailyLock({ lockPath, runId, pid, now: clock(), staleAfterMs, processAlive });
    registry = openJobRegistry({ dbPath, clock });
    recoveredRuns = registry.recoverInterruptedRuns({ now: isoNow(clock), staleAfterMs, isProcessAlive: processAlive });
    registry.createRun({ id: runId, type: 'daily', createdAt: isoNow(clock), ownerPid: pid, metadata: { orchestrator: 'daily-runner' } });
    runCreated = true;
    registry.startRun({ id: runId, type: 'daily', startedAt: isoNow(clock), ownerPid: pid, metadata: { orchestrator: 'daily-runner' } });

    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        try {
          heartbeatDailyLock(lock, clock());
          registry.heartbeatRun(runId, { at: isoNow(clock), ownerPid: pid });
        } catch { /* terminal handling will surface ownership/persistence failures */ }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }

    let discovery;
    try {
      discovery = await discoveryExecutor({ runId, dbPath, registry, cwd, env, scannerStdio });
    } catch (error) {
      registry.recordRunFailure(runId, {
        code: 'ORCHESTRATION_FAILURE',
        message: error instanceof Error ? error.message : String(error),
      });
      const failed = registry.finishRun(runId, { status: 'FAILED', finishedAt: isoNow(clock) });
      return { status: 'FAILED', exitCode: DAILY_EXIT_CODES.FAILED, summary: buildDailySummary(failed, { recoveredRuns }) };
    }

    try {
      if (Array.isArray(discovery?.observations)) registry.recordObservations(runId, discovery.observations);
      if (Array.isArray(discovery?.providerResults)) registry.recordProviderResults(runId, discovery.providerResults);
      if (Array.isArray(discovery?.failures)) {
        for (const failure of discovery.failures) registry.recordRunFailure(runId, failure);
      }
    } catch (error) {
      registry.recordRunFailure(runId, {
        code: 'PERSISTENCE_FAILURE',
        message: error instanceof Error ? error.message : String(error),
      });
      const failed = registry.finishRun(runId, { status: 'FAILED', finishedAt: isoNow(clock) });
      return { status: 'FAILED', exitCode: DAILY_EXIT_CODES.FAILED, summary: buildDailySummary(failed, { recoveredRuns }) };
    }

    const current = registry.getRunSummary(runId);
    const hasProviderFailure = current.providerResults.some(item => item.status === 'FAILED');
    const hasFailures = current.failureDetails.length > 0;
    const status = hasProviderFailure || hasFailures ? 'PARTIAL' : 'SUCCESS';
    const finished = registry.finishRun(runId, { status, finishedAt: isoNow(clock) });
    return {
      status,
      exitCode: DAILY_EXIT_CODES[status],
      summary: buildDailySummary(finished, { recoveredRuns }),
    };
  } catch (error) {
    if (registry && runCreated) {
      try {
        registry.recordRunFailure(runId, { code: 'PERSISTENCE_FAILURE', message: error.message || String(error) });
        const failed = registry.finishRun(runId, { status: 'FAILED', finishedAt: isoNow(clock) });
        return { status: 'FAILED', exitCode: DAILY_EXIT_CODES.FAILED, summary: buildDailySummary(failed, { recoveredRuns }), error: errorDetails(error) };
      } catch { /* the original persistence/lock error is authoritative */ }
    }
    return { status: 'FAILED', exitCode: DAILY_EXIT_CODES.FAILED, summary: null, error: errorDetails(error) };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (registry) registry.close();
    if (lock) releaseDailyLock(lock);
  }
}
