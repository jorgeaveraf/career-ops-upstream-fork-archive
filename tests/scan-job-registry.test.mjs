import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { runDaily } from '../runner/daily-runner.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|---|---|---|---|---|---|---|---|
`;

const PORTALS = `title_filter:
  positive:
    - "Strategic Finance"
tracked_companies:
  - name: Fixture Defense
    careers_url: https://boards.example.com/fixture
    parser:
      command: node
      script: tests/fixtures/three-city-board.mjs
`;

test('scanner dual-writes all acquired observations before filters and preserves Markdown behavior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-registry-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), TRACKER);
    const portals = join(dir, 'portals.yml');
    const dbPath = join(dir, 'data', 'career.db');
    writeFileSync(portals, PORTALS);
    const scan = () => execFileSync(process.execPath, [join(ROOT, 'scan.mjs')], {
      cwd: dir,
      env: { ...process.env, CAREER_OPS_PORTALS: portals, CAREER_OPS_DB: dbPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    scan();
    scan();

    assert.equal(existsSync(dbPath), true);
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 3);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM job_observations').get().n, 3);
      const runs = db.prepare(`
        SELECT observations_count, new_jobs_count, known_jobs_count, duplicate_observations_count
        FROM runs ORDER BY started_at, rowid
      `).all();
      assert.deepEqual(runs, [
        { observations_count: 3, new_jobs_count: 3, known_jobs_count: 0, duplicate_observations_count: 0 },
        { observations_count: 3, new_jobs_count: 0, known_jobs_count: 3, duplicate_observations_count: 3 },
      ]);
    } finally { db.close(); }

    const rows = readFileSync(join(dir, 'data', 'pipeline.md'), 'utf8')
      .split('\n').filter(line => /^- \[ \] https?:\/\//.test(line));
    assert.equal(rows.length, 1, 'legacy company+role dedup still emits one Markdown row');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('daily runner and scanner share one managed run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-scan-registry-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), TRACKER);
    const portals = join(dir, 'portals.yml');
    const dbPath = join(dir, 'data', 'career.db');
    writeFileSync(portals, PORTALS);

    const result = await runDaily({
      cwd: dir,
      dbPath,
      lockPath: join(dir, 'data', 'daily.lock'),
      runId: 'managed-scan',
      heartbeatIntervalMs: 0,
      scannerStdio: 'ignore',
      env: { ...process.env, CAREER_OPS_PORTALS: portals },
    });
    assert.equal(result.status, 'SUCCESS');
    const db = new Database(dbPath, { readonly: true });
    try {
      const runs = db.prepare('SELECT id, type, status FROM runs').all();
      assert.deepEqual(runs, [{ id: 'managed-scan', type: 'daily', status: 'SUCCESS' }]);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM run_provider_results').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM run_observations').get().n, 3);
    } finally { db.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
