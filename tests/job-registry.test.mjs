import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { CURRENT_SCHEMA_VERSION, JobRegistry } from '../registry/job-registry.mjs';
import { canonicalizeJobUrl, hashContent, normalizeJobTitle } from '../acquisition/normalize.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/job-registry-observations.json', import.meta.url), 'utf8'));
const at = (day, hour = 0) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;

function memoryRegistry() {
  return new JobRegistry({ dbPath: ':memory:', clock: () => new Date(at('2026-08-21')) });
}

test('A: new observation creates one canonical job and one observation', () => {
  const registry = memoryRegistry();
  try {
    const run = registry.startRun({ id: 'run-a', startedAt: at('2026-08-21') });
    const result = registry.recordObservation(run.id, { ...fixtures.greenhouse, retrievedAt: at('2026-08-21') });
    const summary = registry.finishRun(run.id, { finishedAt: at('2026-08-21', 1) });
    assert.equal(result.outcome, 'NEW_JOB');
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM job_observations').get().n, 1);
    assert.deepEqual({ observations: summary.observations, newJobs: summary.newJobs }, { observations: 1, newJobs: 1 });
  } finally { registry.close(); }
});

test('B: exact duplicate in a later run reuses the observation and records the sighting', () => {
  const registry = memoryRegistry();
  try {
    registry.startRun({ id: 'run-b1', startedAt: at('2026-08-21') });
    const first = registry.recordObservation('run-b1', { ...fixtures.greenhouse, retrievedAt: at('2026-08-21') });
    registry.finishRun('run-b1');
    registry.startRun({ id: 'run-b2', startedAt: at('2026-08-22') });
    const second = registry.recordObservation('run-b2', { ...fixtures.greenhouse, retrievedAt: at('2026-08-22') });
    const summary = registry.finishRun('run-b2', { finishedAt: at('2026-08-22', 1) });
    assert.equal(second.outcome, 'DUPLICATE_OBSERVATION');
    assert.equal(second.observationId, first.observationId);
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM job_observations').get().n, 1);
    assert.deepEqual(
      { observations: summary.observations, newJobs: summary.newJobs, knownJobs: summary.knownJobs, duplicates: summary.duplicateObservations },
      { observations: 1, newJobs: 0, knownJobs: 1, duplicates: 1 },
    );
  } finally { registry.close(); }
});

test('C: a second provider joins through the same canonical ATS URL', () => {
  const registry = memoryRegistry();
  try {
    registry.startRun({ id: 'run-c' });
    const discovered = registry.recordObservation('run-c', { ...fixtures.himalayasCrossSource, retrievedAt: at('2026-08-21') });
    const ats = registry.recordObservation('run-c', { ...fixtures.greenhouse, retrievedAt: at('2026-08-21', 1) });
    registry.finishRun('run-c');
    assert.equal(ats.outcome, 'NEW_OBSERVATION');
    assert.equal(ats.jobId, discovered.jobId);
    assert.equal(registry.getObservations(ats.jobId).length, 2);
    assert.equal(ats.identity.method, 'canonical_url');
  } finally { registry.close(); }
});

test('D: changed description preserves job identity and marks new content', () => {
  const registry = memoryRegistry();
  try {
    registry.startRun({ id: 'run-d1' });
    const first = registry.recordObservation('run-d1', { ...fixtures.greenhouse, retrievedAt: at('2026-08-21') });
    registry.finishRun('run-d1');
    registry.startRun({ id: 'run-d2', startedAt: at('2026-08-22') });
    const changed = registry.recordObservation('run-d2', { ...fixtures.changedGreenhouse, retrievedAt: at('2026-08-22') });
    const summary = registry.finishRun('run-d2');
    assert.equal(changed.jobId, first.jobId);
    assert.equal(changed.outcome, 'NEW_OBSERVATION');
    assert.equal(changed.contentChanged, true);
    assert.equal(summary.changedJobs, 1);
    assert.equal(registry.getObservations(first.jobId).length, 2);
  } finally { registry.close(); }
});

test('E: similar jobs with distinct requisitions are not merged', () => {
  const registry = memoryRegistry();
  try {
    registry.startRun({ id: 'run-e' });
    const first = registry.recordObservation('run-e', { ...fixtures.greenhouse, retrievedAt: at('2026-08-21') });
    const second = registry.recordObservation('run-e', { ...fixtures.similarDistinct, retrievedAt: at('2026-08-21') });
    assert.notEqual(second.jobId, first.jobId);
    assert.equal(second.identity.method, 'new_ambiguous_candidates');
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 2);
  } finally { registry.close(); }
});

test('E2: same fields and content without a shared strong identity remain separate', () => {
  const registry = memoryRegistry();
  try {
    registry.startRun({ id: 'run-e2' });
    const base = {
      provider: 'public-board-a', sourceUrl: 'https://board-a.example/jobs/one',
      title: 'Platform Engineer', company: 'Acme', location: 'Remote', description: 'Same detailed job body.', retrievedAt: at('2026-08-21'),
    };
    const first = registry.recordObservation('run-e2', base);
    const second = registry.recordObservation('run-e2', { ...base, provider: 'public-board-b', sourceUrl: 'https://board-b.example/jobs/two' });
    assert.notEqual(first.jobId, second.jobId);
    assert.equal(second.identity.method, 'new_ambiguous_candidates');
  } finally { registry.close(); }
});

test('F: state survives closing and reopening the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-registry-'));
  const dbPath = join(dir, 'career.db');
  try {
    let registry = new JobRegistry({ dbPath });
    registry.startRun({ id: 'run-f' });
    const result = registry.recordObservation('run-f', { ...fixtures.ashbyNoExternalId, retrievedAt: at('2026-08-21') });
    registry.finishRun('run-f');
    registry.close();
    registry = new JobRegistry({ dbPath });
    assert.equal(registry.getJob(result.jobId).canonical_title, 'AI Platform Engineer');
    assert.equal(registry.getObservations(result.jobId).length, 1);
    assert.equal(registry.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    registry.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('G: a failed write transaction leaves no partial job or observation', () => {
  const registry = memoryRegistry();
  try {
    registry.startRun({ id: 'run-g' });
    assert.throws(() => registry.recordObservation('run-g', {
      ...fixtures.lever,
      retrievedAt: at('2026-08-21'),
      evidence: [{ field: '', value: 'invalid DB constraint' }],
    }));
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM job_observations').get().n, 0);
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM job_identities').get().n, 0);
  } finally { registry.close(); }
});

test('H: every persisted observation is attributable to its first and current run', () => {
  const registry = memoryRegistry();
  try {
    registry.startRun({ id: 'run-h' });
    const result = registry.recordObservation('run-h', { ...fixtures.lever, retrievedAt: at('2026-08-21') });
    const observation = registry.db.prepare('SELECT * FROM job_observations WHERE id = ?').get(result.observationId);
    const attribution = registry.db.prepare('SELECT * FROM run_observations WHERE observation_id = ?').get(result.observationId);
    assert.equal(observation.first_run_id, 'run-h');
    assert.equal(attribution.run_id, 'run-h');
  } finally { registry.close(); }
});

test('I: canonicalization and content hashes are deterministic', () => {
  const a = canonicalizeJobUrl('HTTPS://Jobs.Example.com/Role/ABC/?utm_source=x&b=2&a=1#apply');
  const b = canonicalizeJobUrl('https://jobs.example.com/role/abc?a=1&b=2');
  assert.equal(a, b);
  assert.equal(normalizeJobTitle('  Senior—AI  Engineer '), normalizeJobTitle('senior AI engineer'));
  assert.equal(hashContent('<p>Build AI systems.</p>'), hashContent('Build AI systems.'));
});

test('migration ledger and SQLite concurrency pragmas are explicit', () => {
  const registry = memoryRegistry();
  try {
    assert.deepEqual(registry.db.prepare('SELECT version, name FROM schema_migrations').all(), [
      { version: 1, name: '001_operational_registry.sql' },
      { version: 2, name: '002_run_lifecycle.sql' },
      { version: 3, name: '003_opportunity_assessments.sql' },
      { version: 4, name: '004_job_evaluations.sql' },
      { version: 5, name: '005_application_packages.sql' },
      { version: 6, name: '006_contact_intelligence.sql' },
      { version: 7, name: '007_human_control_plane.sql' },
      { version: 8, name: '008_daily_operational_loop.sql' },
      { version: 9, name: '009_browser_research.sql' },
      { version: 10, name: '010_browser_discovery_metrics.sql' },
      { version: 11, name: '011_browser_discovery_strategy.sql' },
      { version: 12, name: '012_bounded_candidate_set.sql' },
      { version: 13, name: '013_eligibility_evidence_repair.sql' },
      { version: 14, name: '014_browser_semantic_execution.sql' },
      { version: 15, name: '015_human_decision_feedback_loop.sql' },
      { version: 16, name: '016_deep_application_enrichment.sql' },
      { version: 17, name: '017_facebook_community_discovery.sql' },
      { version: 18, name: '018_facebook_community_join_lifecycle.sql' },
      { version: 19, name: '019_facebook_membership_reconciliation.sql' },
      { version: 20, name: '020_facebook_live_monitoring.sql' },
      { version: 21, name: '021_application_execution_feedback_calibration.sql' },
      { version: 22, name: '022_today_centric_lifecycle.sql' },
      { version: 23, name: '023_application_authorization_supersession.sql' },
      { version: 24, name: '024_workflow_commands.sql' },
      { version: 25, name: '025_canonical_workflow_events.sql' },
      { version: 26, name: '026_actionable_notification_outbox.sql' },
      { version: 27, name: '027_operational_intelligence.sql' },
      { version: 28, name: '028_contact_intelligence_v4.sql' },
      { version: 29, name: '029_application_activation_outreach.sql' },
      { version: 30, name: '030_autonomous_outreach_execution.sql' },
      { version: 31, name: '031_execution_orchestration.sql' },
      { version: 32, name: '032_autonomous_browser_application_execution.sql' },
      { version: 33, name: '033_frictionless_human_handoff.sql' },
      { version: 34, name: '034_human_handoff_reactivation.sql' },
      { version: 35, name: '035_application_question_intelligence.sql' },
    ]);
    assert.equal(registry.db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(registry.db.pragma('busy_timeout', { simple: true }), 5000);
  } finally { registry.close(); }
});
