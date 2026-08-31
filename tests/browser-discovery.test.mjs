import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { toNormalizedObservation } from '../acquisition/provider-adapter.mjs';
import { BrowserJobSearchProvider } from '../research/browser-job-search-provider.mjs';
import { buildBrowserDiscoveryTasks } from '../research/discovery-tasks.mjs';
import { browserDiscoverySourceAdapters } from '../research/discovery-source-adapters.mjs';
import { runBrowserDiscovery } from '../research/discovery-runner.mjs';
import { shouldRunBrowserDiscoveryScheduled } from '../research/runner.mjs';
import { withProviderQualityMetrics } from '../research/provider-quality.mjs';
import { runBrowserDiscoveryWindow } from '../automation/browser-discovery-window.mjs';
import { MemorySheetsAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const NOW = '2026-08-23T22:00:00.000Z'; const clock = () => new Date(NOW);
const adapters = browserDiscoverySourceAdapters();
const linkedInRecord = {
  url: 'https://www.linkedin.com/jobs/view/123?trackingId=fixture', title: 'AI Systems Engineer',
  company: 'Example Inc', location: 'Remote - LATAM', modality: 'Remote', description: 'Build reliable AI systems.',
};

test('BrowserJobSearchProvider returns a valid AcquisitionResult and RawJobPosting', async () => {
  const browserAdapter = { discover: async () => ({ retrievedAt: NOW, records: [linkedInRecord] }) };
  const provider = new BrowserJobSearchProvider({ sourceAdapter: adapters.get('linkedin'), browserAdapter, clock });
  const task = { id: 'one', source: 'linkedin', url: 'https://www.linkedin.com/jobs/search/?keywords=AI', query: 'AI Systems Engineer', filters: {} };
  const result = await provider.acquire(task, { session: { profile: 'jorge' } }, { runId: 'discovery-1', retrievedAt: NOW });
  assert.equal(result.ok, true); assert.equal(result.data.length, 1); assert.deepEqual(result.metrics, { discovered: 1, valid: 1 });
  const job = result.data[0];
  assert.equal(job.provenance.providerId, 'browser:linkedin'); assert.equal(job.provenance.extractionMethod, 'parsed');
  assert.equal(job.provenance.retrievedAt, NOW); assert.equal(job.confidence, 'medium');
  assert.equal(job.externalId, '123'); assert.equal(job.sourceUrl, linkedInRecord.url);
  assert.ok(job.evidence.some(item => item.field === 'title' && item.confidence === 'medium'));
  assert.deepEqual(result.attempts[0].actions, []);
});

test('AI Systems Engineer discovery task produces source-correct remote senior queries', () => {
  const tasks = buildBrowserDiscoveryTasks({ config: { discovery: { jobQueries: ['AI Systems Engineer'] } }, adapters });
  assert.deepEqual(tasks.map(item => item.source), ['linkedin', 'indeed', 'occ']);
  const linkedIn = new URL(tasks.find(item => item.source === 'linkedin').url);
  assert.match(linkedIn.searchParams.get('keywords'), /AI Systems Engineer/); assert.equal(linkedIn.searchParams.get('f_WT'), '2'); assert.equal(linkedIn.searchParams.get('f_E'), '4');
  const indeed = new URL(tasks.find(item => item.source === 'indeed').url);
  assert.match(indeed.searchParams.get('q'), /remote/); assert.match(indeed.searchParams.get('q'), /senior/);
  assert.ok(tasks.every(item => item.type === 'JOB_DISCOVERY' && item.filters.contractor === 'preferred'));
});

test('Facebook is prepared in research config but excluded from Browser Discovery', () => {
  const tasks = buildBrowserDiscoveryTasks({ config: { discovery: { enabledSources: ['linkedin', 'facebook'], jobQueries: ['AI Systems Engineer'] } }, adapters });
  assert.deepEqual(tasks.map(item => item.source), ['linkedin']);
});

test('LinkedIn, Indeed, and OCC adapters extract the minimal stable job fields', () => {
  const fixtures = {
    linkedin: linkedInRecord,
    indeed: { url: 'https://mx.indeed.com/viewjob?jk=abc123', title: 'Data Engineer', company: 'Indeed Co', location: 'Remoto' },
    occ: { url: 'https://www.occ.com.mx/empleo/oferta/senior-data-456', title: 'Senior Data Engineer', company: 'OCC Co', location: 'México' },
  };
  for (const [source, record] of Object.entries(fixtures)) {
    const job = adapters.get(source).parse(record);
    assert.equal(job.title, record.title); assert.equal(job.company, record.company); assert.ok(job.url.startsWith('https://'));
    assert.equal(job.modality, record.modality || 'UNKNOWN'); assert.equal(job.description, record.description || 'UNKNOWN'); assert.equal(job.rawMetadata.source, source);
  }
});

test('browser job maps through the existing Acquisition normalization boundary', async () => {
  const provider = new BrowserJobSearchProvider({ sourceAdapter: adapters.get('linkedin'), browserAdapter: { discover: async () => ({ retrievedAt: NOW, records: [linkedInRecord] }) }, clock });
  const result = await provider.acquire({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/search/', query: 'AI', filters: {} }, { session: { profile: 'jorge' } }, { runId: 'map-run', retrievedAt: NOW });
  const observation = toNormalizedObservation(result.data[0], { providerId: provider.id, runId: 'map-run' });
  assert.equal(observation.provider, 'browser:linkedin'); assert.equal(observation.extractionMethod, 'parsed'); assert.equal(observation.confidence, 'medium');
  assert.equal(observation.rawMetadata.provenance.sourceUrl, linkedInRecord.url);
});

test('Browser Discovery persists only through Registry Boundary and records Provider ROI inputs', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  const browserAdapter = { async start() {}, async close() {}, async discover() { return { retrievedAt: NOW, records: [linkedInRecord] }; } };
  const task = buildBrowserDiscoveryTasks({ config: { discovery: { enabledSources: ['linkedin'], jobQueries: ['AI Systems Engineer'] } }, adapters })[0];
  const manager = { acquire: () => ({ profile: 'jorge', mode: 'research_only', profileDirectory: 'Default' }), release() {} };
  try {
    const first = await runBrowserDiscovery({ registry, sessionManager: manager, selection: { profile: 'jorge' }, browserAdapter, sourceAdapters: adapters, tasks: [task], runId: 'discovery-first', clock });
    assert.equal(first.status, 'SUCCESS'); assert.equal(first.run.newJobs, 1);
    assert.deepEqual({ discovered: first.providers[0].discovered, valid: first.providers[0].valid, duplicates: first.providers[0].duplicates, providerRoi: first.providers[0].providerRoi }, { discovered: 1, valid: 1, duplicates: 0, providerRoi: 0 });
    const taskState = registry.db.prepare('SELECT provider, target, status, started_at, finished_at FROM run_provider_results WHERE run_id = ?').get('discovery-first');
    assert.deepEqual({ provider: taskState.provider, query: taskState.target, status: taskState.status }, { provider: 'browser:linkedin', query: 'AI Systems Engineer', status: 'SUCCESS' });
    assert.ok(taskState.started_at); assert.ok(taskState.finished_at);
    const second = await runBrowserDiscovery({ registry, sessionManager: manager, selection: { profile: 'jorge' }, browserAdapter, sourceAdapters: adapters, tasks: [task], runId: 'discovery-second', clock });
    assert.equal(second.run.duplicateObservations, 1); assert.equal(second.providers[0].duplicates, 1);
    assert.equal(registry.db.prepare('SELECT COUNT(*) count FROM jobs').get().count, 1);
  } finally { registry.close(); }
});

test('Browser and ATS observations deduplicate through existing canonical URL evidence', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  const common = { canonicalUrl: 'https://job-boards.greenhouse.io/example/jobs/456', title: 'AI Engineer', company: 'Example', location: 'Remote', description: 'same job', retrievedAt: NOW };
  try {
    registry.startRun({ id: 'ats', type: 'discovery', startedAt: NOW });
    const ats = registry.recordObservation('ats', { ...common, provider: 'greenhouse', sourceUrl: common.canonicalUrl, externalId: '456' }); registry.finishRun('ats', { status: 'SUCCESS', finishedAt: NOW });
    registry.startRun({ id: 'browser', type: 'browser-discovery', startedAt: NOW });
    const browser = registry.recordObservation('browser', { ...common, provider: 'browser:linkedin', sourceUrl: 'https://www.linkedin.com/jobs/view/999', externalId: '999', extractionMethod: 'parsed', confidence: 'medium' }); registry.finishRun('browser', { status: 'SUCCESS', finishedAt: NOW });
    assert.equal(browser.jobId, ats.jobId); assert.equal(browser.identity.method, 'canonical_url'); assert.equal(registry.db.prepare('SELECT COUNT(*) count FROM jobs').get().count, 1);
  } finally { registry.close(); }
});

test('discovery dry-run does not open Chrome or write Registry state', () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const result = spawnSync(process.execPath, ['browser-research.mjs', '--discover', '--dry-run', '--json', '--source', 'linkedin', '--query', 'AI Systems Engineer', '--max-results', '5'], { cwd: root, encoding: 'utf8', env: { ...process.env, BROWSER_USER_DATA_DIR: '' } });
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout);
  assert.equal(output.discover, true); assert.equal(output.navigationStarted, false); assert.equal(output.automaticDailyIntegration, false); assert.deepEqual(output.writes, []);
  assert.equal(output.tasks.length, 1); assert.equal(output.tasks[0].source, 'linkedin'); assert.equal(output.tasks[0].maxResults, 5);
});

test('Browser Discovery exposes no mutation or social-action API', () => {
  const provider = new BrowserJobSearchProvider({ sourceAdapter: adapters.get('linkedin'), browserAdapter: { discover: async () => ({ records: [] }) } });
  for (const action of ['apply', 'submit', 'message', 'connect', 'post', 'fill', 'click']) assert.equal(provider[action], undefined);
  const source = readFileSync(new URL('../research/discovery-runner.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /daily-auto|runOperationalLoop|sendSummary|outreach/i);
});

test('a second Career Ops session fails Browser Discovery cleanly before navigation', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock }); let started = false;
  const error = new Error('Career Ops session is already active'); error.code = 'BROWSER_SESSION_LOCKED';
  try {
    const result = await runBrowserDiscovery({
      registry, selection: { profile: 'jorge' }, sessionManager: { acquire() { throw error; }, release() {} },
      browserAdapter: { async start() { started = true; }, async discover() { return { records: [] }; } },
      sourceAdapters: adapters, tasks: [], runId: 'locked-discovery', clock,
    });
    assert.equal(result.status, 'FAILED'); assert.equal(result.failures[0].code, 'BROWSER_SESSION_LOCKED'); assert.equal(started, false);
  } finally { registry.close(); }
});

test('unavailable Chrome profile fails Browser Discovery cleanly before navigation', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock }); let started = false;
  const error = new Error('Jorge profile is unavailable'); error.code = 'BROWSER_PROFILE_UNAVAILABLE';
  try {
    const result = await runBrowserDiscovery({
      registry, selection: { profile: 'jorge' }, sessionManager: { acquire() { throw error; }, release() {} },
      browserAdapter: { async start() { started = true; }, async discover() { return { records: [] }; } },
      sourceAdapters: adapters, tasks: [], runId: 'unavailable-discovery', clock,
    });
    assert.equal(result.status, 'FAILED'); assert.equal(result.failures[0].code, 'BROWSER_PROFILE_UNAVAILABLE'); assert.equal(started, false);
  } finally { registry.close(); }
});

test('one provider failure is PARTIAL and does not stop the remaining configured source', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  const tasks = buildBrowserDiscoveryTasks({ config: { browser_discovery: { sources: {
    linkedin: { enabled: true, queries: ['AI Systems Engineer'] },
    occ: { enabled: true, queries: ['Senior Data Engineer'] },
  } } }, adapters });
  const browserAdapter = {
    async start() {}, async close() {},
    async discover({ task }) {
      if (task.source === 'linkedin') { const error = new Error('fixture source unavailable'); error.code = 'BROWSER_SOURCE_UNAVAILABLE'; throw error; }
      return { retrievedAt: NOW, records: [{ url: 'https://www.occ.com.mx/empleo/oferta/data-123', title: 'Senior Data Engineer', company: 'Example OCC', location: 'Remoto' }] };
    },
  };
  try {
    const result = await runBrowserDiscovery({
      registry, selection: { profile: 'jorge' }, sessionManager: { acquire: () => ({ profile: 'jorge' }), release() {} },
      browserAdapter, sourceAdapters: adapters, tasks, runId: 'partial-discovery', clock,
    });
    assert.equal(result.status, 'PARTIAL'); assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].provider, 'browser:linkedin');
    assert.ok(result.providers.some(item => item.provider === 'browser:occ' && item.valid === 1));
    const states = registry.db.prepare('SELECT provider, target, status FROM run_provider_results WHERE run_id = ? ORDER BY provider').all('partial-discovery');
    assert.deepEqual(states, [
      { provider: 'browser:linkedin', target: 'AI Systems Engineer', status: 'FAILED' },
      { provider: 'browser:occ', target: 'Senior Data Engineer', status: 'SUCCESS' },
    ]);
  } finally { registry.close(); }
});

test('nested Browser Discovery configuration enables sources and per-source queries', () => {
  const tasks = buildBrowserDiscoveryTasks({ config: { browser_discovery: {
    enabled: true, queries: ['Global A', 'Global B'], sources: {
      linkedin: { enabled: true, queries: ['LinkedIn A'] },
      indeed: { enabled: false, queries: ['Indeed A'] },
      occ: { enabled: true }, facebook: { enabled: false },
    },
  } }, adapters });
  assert.deepEqual(tasks.map(item => [item.source, item.query]), [
    ['linkedin', 'LinkedIn A'], ['occ', 'Global A'], ['occ', 'Global B'],
  ]);
  assert.deepEqual(buildBrowserDiscoveryTasks({ config: { browser_discovery: { enabled: false } }, adapters }), []);
});

test('scheduled Browser Discovery guard enforces enabled state, 16:00 window, and one run per local day', () => {
  const registry = { latest: null, getLatestRunByType(type) { assert.equal(type, 'browser-discovery'); return this.latest; } };
  assert.equal(shouldRunBrowserDiscoveryScheduled({ registry, enabled: false, now: new Date(NOW) }).reason, 'BROWSER_DISCOVERY_DISABLED');
  assert.equal(shouldRunBrowserDiscoveryScheduled({ registry, now: new Date('2026-08-23T21:59:00Z') }).reason, 'BEFORE_DISCOVERY_WINDOW');
  assert.equal(shouldRunBrowserDiscoveryScheduled({ registry, now: new Date(NOW) }).reason, 'DUE');
  registry.latest = { id: 'browser-today', status: 'SUCCESS', started_at: NOW };
  assert.equal(shouldRunBrowserDiscoveryScheduled({ registry, now: new Date('2026-08-24T01:00:00Z') }).reason, 'BROWSER_DISCOVERY_ALREADY_RAN');
});

test('provider quality metrics calculate shortlist and package conversion without auto-decisions', () => {
  assert.deepEqual(withProviderQualityMetrics({ provider: 'browser:linkedin', discovered: 50, shortlist: 8, packagesReady: 4 }), {
    provider: 'browser:linkedin', discovered: 50, shortlist: 8, packagesReady: 4,
    providerRoi: 0.16, evaluationRoi: 0.08,
  });
  assert.deepEqual(withProviderQualityMetrics({ provider: 'greenhouse', discovered: 0, shortlist: 2, packages: 1 }), {
    provider: 'greenhouse', discovered: 0, shortlist: 2, packages: 1,
    providerRoi: 0, evaluationRoi: 0,
  });
});

test('provider performance view compares core and browser sources without choosing a winner', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  try {
    registry.startRun({ id: 'core-performance', type: 'discovery', startedAt: NOW });
    registry.recordProviderResult('core-performance', { provider: 'greenhouse', target: 'fixture-board', status: 'SUCCESS', observations: 5, startedAt: NOW, finishedAt: NOW });
    registry.finishRun('core-performance', { status: 'SUCCESS', finishedAt: NOW });
    registry.startRun({ id: 'browser-performance', type: 'browser-discovery', startedAt: NOW });
    registry.recordBrowserDiscoveryMetrics('browser-performance', [{ provider: 'browser:linkedin', discovered: 3, valid: 2, duplicates: 1 }]);
    registry.finishRun('browser-performance', { status: 'SUCCESS', finishedAt: NOW });
    const comparison = registry.getProviderPerformance();
    assert.ok(comparison.some(item => item.provider === 'greenhouse' && item.discovered === 5));
    assert.ok(comparison.some(item => item.provider === 'browser:linkedin' && item.discovered === 3 && item.duplicates === 1));
    assert.ok(comparison.every(item => !Object.hasOwn(item, 'decision') && !Object.hasOwn(item, 'enabled')));
  } finally { registry.close(); }
});

test('scheduled discovery window ranks only its run and optionally refreshes SOURCE_METRICS', async () => {
  const coreJobs = [['Job ID', 'Title'], ['existing', 'Keep me']];
  const sheetAdapter = new MemorySheetsAdapter({ tabs: { JOBS: coreJobs } });
  const metrics = [{ provider: 'browser:linkedin', discovered: 10, valid: 8, duplicates: 2, eligible: 4, shortlist: 2, evaluations: 1, packagesReady: 1, providerRoi: 0.2, evaluationRoi: 0.1, lastRun: NOW }];
  const strategyMetrics = [{ ...metrics[0], strategy: 'linkedin_feed', discovered: 4, shortlist: 1, providerRoi: 0.25 }];
  const registry = {
    getBrowserDiscoveryMetrics(id) { assert.equal(id, 'scheduled-browser-run'); return metrics; },
    getBrowserDiscoveryStrategyMetrics(id) { assert.equal(id, 'scheduled-browser-run'); return strategyMetrics; },
    getProviderPerformance() { return metrics; },
  };
  let rankingInput;
  const result = await runBrowserDiscoveryWindow({
    registry, discoveryOptions: { tasks: [{ id: 'fixture' }] }, spreadsheetId: 'fixture-sheet', sheetAdapter,
    discoveryStage: async () => ({ status: 'SUCCESS', exitCode: 0, run: { id: 'scheduled-browser-run' }, failures: [] }),
    rankingStage: async input => { rankingInput = input; return { processed: 8, eligible: 4, shortlisted: 2, shortlistedJobIds: ['job-1'], recommendations: [] }; },
  });
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.automaticDailyIntegration, false);
  assert.equal(rankingInput.discoveryRunId, 'scheduled-browser-run');
  assert.deepEqual(sheetAdapter.tabs.JOBS, coreJobs);
  assert.deepEqual(Object.keys(sheetAdapter.tabs).sort(), ['JOBS', 'SOURCE_METRICS']);
  assert.equal(result.sheet.tab, 'SOURCE_METRICS'); assert.equal(sheetAdapter.tabs.SOURCE_METRICS.length, 3);
  assert.equal(sheetAdapter.tabs.SOURCE_METRICS[1][0], 'LIFETIME');
  assert.equal(sheetAdapter.tabs.SOURCE_METRICS[1][1], 'browser:linkedin');
  assert.equal(sheetAdapter.tabs.SOURCE_METRICS[1][2], 'ALL');
  assert.equal(sheetAdapter.tabs.SOURCE_METRICS[2][2], 'linkedin_feed');
});

test('scheduled dry-run plans Browser Discovery without browser or registry writes', () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const result = spawnSync(process.execPath, ['browser-research.mjs', '--scheduled', '--dry-run', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, BROWSER_USER_DATA_DIR: '', CAREER_OPS_DB: '/should/not/be/created.db' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.discover, true); assert.equal(output.navigationStarted, false);
  assert.equal(output.automaticDailyIntegration, false); assert.deepEqual(output.writes, []);
  assert.ok(output.tasks.length > 0);
  assert.ok(output.tasks.every(task => task.source === 'linkedin'));
  assert.ok(output.tasks.every(task => task.mode === 'targeted_search'));
  assert.ok(!output.tasks.some(task => task.mode === 'personalized_feed'));
});
