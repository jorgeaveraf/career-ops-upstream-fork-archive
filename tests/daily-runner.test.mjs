import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { JobRegistry } from '../registry/job-registry.mjs';
import { buildDailySummary, runDaily } from '../runner/daily-runner.mjs';

const NOW = '2026-08-22T07:00:00.000Z';
const clock = () => new Date(NOW);

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-daily-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  return { dir, dbPath: join(dir, 'data', 'career.db'), lockPath: join(dir, 'data', 'daily.lock') };
}

function observation(id = '1') {
  return {
    provider: 'fixture', externalId: id,
    sourceUrl: `https://jobs.example.test/${id}`,
    title: 'Platform Engineer', company: 'Fixture Co', location: 'Remote',
    description: `Fixture description ${id}`, retrievedAt: NOW,
    extractionMethod: 'direct', confidence: 'high',
  };
}

test('A: successful daily execution follows PENDING -> RUNNING -> SUCCESS', async () => {
  const sb = sandbox();
  try {
    const observed = [];
    const result = await runDaily({
      ...sb, clock, runId: 'daily-success', heartbeatIntervalMs: 0,
      discoveryExecutor: async ({ runId, registry }) => {
        observed.push(registry.getRun(runId).status);
        return {
          observations: [observation()],
          providerResults: [{ provider: 'fixture', target: 'Fixture Co', status: 'SUCCESS', observations: 1 }],
        };
      },
    });
    const registry = new JobRegistry({ dbPath: sb.dbPath });
    try {
      assert.deepEqual(observed, ['RUNNING']);
      assert.equal(result.status, 'SUCCESS');
      assert.equal(result.exitCode, 0);
      assert.equal(registry.getRun('daily-success').status, 'SUCCESS');
      assert.equal(result.summary.discovery.newJobs, 1);
    } finally { registry.close(); }
  } finally { rmSync(sb.dir, { recursive: true, force: true }); }
});

test('lifecycle exposes PENDING before a run starts', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  try {
    assert.equal(registry.createRun({ id: 'pending' }).status, 'PENDING');
    assert.equal(registry.startRun({ id: 'pending' }).status, 'RUNNING');
  } finally { registry.close(); }
});

test('B: provider failure makes a completed orchestration PARTIAL', async () => {
  const sb = sandbox();
  try {
    const result = await runDaily({
      ...sb, clock, runId: 'daily-partial', heartbeatIntervalMs: 0,
      discoveryExecutor: async () => ({
        providerResults: [
          { provider: 'provider-a', target: 'A', status: 'SUCCESS', observations: 4 },
          { provider: 'provider-b', target: 'B', status: 'FAILED', errorCode: 'TIMEOUT', errorMessage: 'timed out' },
        ],
        failures: [{ provider: 'provider-b', target: 'B', code: 'TIMEOUT', message: 'timed out', retryable: true }],
      }),
    });
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.summary.providers.map(item => [item.provider, item.status]), [
      ['provider-a', 'SUCCESS'], ['provider-b', 'FAILED'],
    ]);
  } finally { rmSync(sb.dir, { recursive: true, force: true }); }
});

test('C: scanner/orchestration failure makes the run FAILED', async () => {
  const sb = sandbox();
  try {
    const result = await runDaily({
      ...sb, clock, runId: 'daily-failed', heartbeatIntervalMs: 0,
      discoveryExecutor: async () => { throw new Error('scanner failed before persistence'); },
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.failures[0].code, 'ORCHESTRATION_FAILURE');
  } finally { rmSync(sb.dir, { recursive: true, force: true }); }
});

test('persistence failure is distinguished from provider and orchestration failures', async () => {
  const sb = sandbox();
  try {
    const result = await runDaily({
      ...sb, clock, runId: 'daily-persistence-failed', heartbeatIntervalMs: 0,
      discoveryExecutor: async () => ({ observations: [{ provider: 'fixture' }] }),
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.summary.failures[0].code, 'PERSISTENCE_FAILURE');
  } finally { rmSync(sb.dir, { recursive: true, force: true }); }
});

test('D: lock prevents duplicate execution', async () => {
  const sb = sandbox();
  let releaseFirst;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  try {
    const first = runDaily({
      ...sb, clock, runId: 'daily-lock-a', heartbeatIntervalMs: 0,
      discoveryExecutor: async () => {
        signalStarted();
        await new Promise(resolve => { releaseFirst = resolve; });
        return { providerResults: [] };
      },
    });
    await started;
    const second = await runDaily({
      ...sb, clock, runId: 'daily-lock-b', heartbeatIntervalMs: 0,
      discoveryExecutor: async () => { throw new Error('must not execute'); },
    });
    assert.equal(second.status, 'FAILED');
    assert.equal(second.error.code, 'DAILY_RUN_LOCKED');
    releaseFirst();
    assert.equal((await first).status, 'SUCCESS');
  } finally { rmSync(sb.dir, { recursive: true, force: true }); }
});

test('E/F/H: stale lock recovery interrupts abandoned run and survives restart', async () => {
  const sb = sandbox();
  try {
    let registry = new JobRegistry({ dbPath: sb.dbPath, clock: () => new Date('2026-08-21T00:00:00.000Z') });
    registry.startRun({ id: 'abandoned', ownerPid: 999999, startedAt: '2026-08-21T00:00:00.000Z' });
    registry.close();
    writeFileSync(sb.lockPath, JSON.stringify({
      token: 'stale', runId: 'abandoned', pid: 999999,
      acquiredAt: '2026-08-21T00:00:00.000Z', heartbeatAt: '2026-08-21T00:00:00.000Z',
    }));

    const result = await runDaily({
      ...sb, clock, runId: 'replacement', staleAfterMs: 60_000,
      processAlive: () => false, heartbeatIntervalMs: 0,
      discoveryExecutor: async () => ({ providerResults: [] }),
    });
    assert.deepEqual(result.summary.recovery.interruptedRunIds, ['abandoned']);
    registry = new JobRegistry({ dbPath: sb.dbPath });
    try {
      assert.equal(registry.getRun('abandoned').status, 'INTERRUPTED');
      assert.equal(registry.getRun('replacement').status, 'SUCCESS');
    } finally { registry.close(); }
    assert.equal(existsSync(sb.lockPath), false);
  } finally { rmSync(sb.dir, { recursive: true, force: true }); }
});

test('G: dry run creates no lock, database, or Markdown changes', async () => {
  const sb = sandbox();
  const pipeline = join(sb.dir, 'data', 'pipeline.md');
  writeFileSync(pipeline, '# unchanged\n');
  try {
    const before = readFileSync(pipeline, 'utf8');
    const result = await runDaily({ ...sb, dryRun: true, discoveryExecutor: async () => { throw new Error('must not execute'); } });
    assert.equal(result.dryRun, true);
    assert.equal(existsSync(sb.dbPath), false);
    assert.equal(existsSync(sb.lockPath), false);
    assert.equal(readFileSync(pipeline, 'utf8'), before);
  } finally { rmSync(sb.dir, { recursive: true, force: true }); }
});

test('I: structured summary is deterministic for the same persisted input', () => {
  const input = {
    id: 'same', type: 'daily', status: 'PARTIAL', createdAt: NOW, startedAt: NOW,
    finishedAt: NOW, durationMs: 0, observations: 2, newJobs: 1, changedJobs: 0,
    knownJobs: 1, duplicateObservations: 1,
    providerResults: [
      { provider: 'zeta', target: 'Z', status: 'SUCCESS', observations: 1 },
      { provider: 'alpha', target: 'A', status: 'FAILED', observations: 1 },
    ],
    failureDetails: [{ provider: 'alpha', target: 'A', code: 'TIMEOUT', message: 'timeout', retryable: true, recordedAt: NOW }],
  };
  assert.deepEqual(buildDailySummary(input), buildDailySummary(structuredClone(input)));
  assert.deepEqual(buildDailySummary(input).providers.map(item => item.provider), ['alpha', 'zeta']);
});
