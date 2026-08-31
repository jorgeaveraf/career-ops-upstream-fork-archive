import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { JobRegistry } from '../registry/job-registry.mjs';
import { bootstrapRegistry, parsePipeline, parseScanHistory } from '../job-registry.mjs';

const HISTORY = `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\nhttps://job-boards.greenhouse.io/acme/jobs/123?utm_source=scan\t2026-08-17\tgreenhouse-api\tAI Engineer\tAcme\tadded\tRemote\tabcdef0123456789\t2026-08-16\n`;

const PIPELINE = `# Pipeline\n\n## Pending\n\n- [ ] https://jobs.ashbyhq.com/example/2c7dc676-bb52-48e8-9e8a-41f9482f343f | Example | Platform Engineer | Mexico\n\n## Processed\n\n- [x] #-- | https://job-boards.greenhouse.io/acme/jobs/123 | Acme | AI Engineer | Remote | note: EVALUADA — fixture\n`;

test('legacy parsers preserve reliable fields without inventing missing values', () => {
  const history = parseScanHistory(HISTORY);
  const pipeline = parsePipeline(PIPELINE, '2026-08-21T00:00:00.000Z');
  assert.equal(history[0].externalId, '123');
  assert.equal(history[0].rawMetadata.legacyFingerprint, 'abcdef0123456789');
  assert.equal(history[0].contentHash, undefined);
  assert.equal(pipeline[0].externalId, undefined);
  assert.equal(pipeline[0].provider, 'legacy-pipeline');
  assert.equal(pipeline[1].rawMetadata.legacyDisposition, 'EVALUATED');
});

test('bootstrap is explicit, additive, and idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-bootstrap-'));
  const historyPath = join(dir, 'history.tsv');
  const pipelinePath = join(dir, 'pipeline.md');
  const dbPath = join(dir, 'career.db');
  writeFileSync(historyPath, HISTORY);
  writeFileSync(pipelinePath, PIPELINE);
  const registry = new JobRegistry({ dbPath });
  try {
    const first = bootstrapRegistry(registry, { historyPath, pipelinePath, now: '2026-08-21T00:00:00.000Z' });
    const jobsAfterFirst = registry.db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
    const observationsAfterFirst = registry.db.prepare('SELECT COUNT(*) n FROM job_observations').get().n;
    const second = bootstrapRegistry(registry, { historyPath, pipelinePath, now: '2026-08-22T00:00:00.000Z' });
    assert.equal(first.newJobs, 2);
    assert.equal(jobsAfterFirst, 2);
    assert.equal(observationsAfterFirst, 3);
    assert.equal(registry.findByCanonicalUrl('https://job-boards.greenhouse.io/acme/jobs/123').status, 'EVALUATED');
    assert.equal(second.reused, true);
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, jobsAfterFirst);
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM job_observations').get().n, observationsAfterFirst);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
