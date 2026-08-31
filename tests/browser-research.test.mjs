import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { BrowserResearchProvider, validateBrowserResearchObservation } from '../research/browser-research-provider.mjs';
import { BrowserSessionManager, selectChromeProfile } from '../research/browser-session-manager.mjs';
import { ManagedChromeResearchAdapter, PlaywrightReadOnlyAdapter } from '../research/playwright-read-only-adapter.mjs';
import { ManagedBrowserSession, managedBrowserSessionConfigFromEnv } from '../research/managed-browser-session.mjs';
import { MacOsChromeWindowDriver } from '../research/macos-chrome-window-driver.mjs';
import { runBrowserResearch, shouldRunBrowserResearchScheduled } from '../research/runner.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const NOW = '2026-08-23T22:00:00.000Z';
const clock = () => new Date(NOW);

function chromeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-chrome-'));
  mkdirSync(path.join(root, 'Default'));
  writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Jorge' }, 'Profile 2': { name: 'Brunova' }, 'Profile 3': { name: 'HQ' } } } }));
  return { root, selection: selectChromeProfile({ profile: 'jorge', mode: 'research_only', userDataDir: root }) };
}

function jobFinding() {
  return {
    entityType: 'JOB', source: 'linkedin', sourceUrl: 'https://www.linkedin.com/jobs/view/123', retrievedAt: NOW,
    extractionMethod: 'parsed', confidence: 'high', data: { title: 'AI Systems Engineer', company: 'Example', location: 'Remote' },
    evidence: [{ field: 'title', value: 'AI Systems Engineer', sourceUrl: 'https://www.linkedin.com/jobs/view/123' }],
    provenance: { mode: 'RESEARCH_ONLY', profile: 'jorge', actions: [], contentHash: 'fixture' },
  };
}

test('BrowserResearchProvider returns contract-valid evidence with enforced provenance', async () => {
  const adapter = { async read() { return { text: 'fixture', findings: [jobFinding()] }; } };
  const provider = new BrowserResearchProvider({ adapter, clock });
  const result = await provider.research({ tasks: [{ id: 'task-1', source: 'linkedin', url: jobFinding().sourceUrl }], session: { profile: 'jorge', profileDirectory: 'Default' }, runId: 'run-1' });
  assert.equal(result.observations.length, 1); assert.equal(result.failures.length, 0);
  assert.equal(result.observations[0].provenance.mode, 'RESEARCH_ONLY');
  assert.equal(result.observations[0].provenance.profile, 'jorge');
  assert.deepEqual(result.observations[0].provenance.actions, []);
  assert.ok(result.observations[0].observationKey);
});

test('profile selection resolves only the existing Chrome profile named Jorge', () => {
  const fixture = chromeFixture();
  assert.equal(fixture.selection.profileDirectory, 'Default'); assert.equal(fixture.selection.profileName, 'Jorge');
  assert.throws(() => selectChromeProfile({ profile: 'brunova', mode: 'research_only', userDataDir: fixture.root }), error => error.code === 'BROWSER_PROFILE_DENIED');
  assert.throws(() => selectChromeProfile({ profile: 'jorge', mode: 'write', userDataDir: fixture.root }), error => error.code === 'BROWSER_MODE_DENIED');
});

test('profile selection fails cleanly when Chrome state is unavailable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-no-chrome-'));
  assert.throws(() => selectChromeProfile({ profile: 'jorge', mode: 'research_only', userDataDir: root }), error => error.code === 'BROWSER_PROFILE_UNAVAILABLE');
});

test('existing Chrome locks do not block Career Ops, while a second Career Ops session does', () => {
  const fixture = chromeFixture(); const lockPath = path.join(fixture.root, 'career-ops.lock');
  const chromeLock = path.join(fixture.root, 'SingletonLock'); writeFileSync(chromeLock, 'occupied');
  const manager = new BrowserSessionManager({ lockPath, processAlive: () => true, clock });
  const first = manager.acquire(fixture.selection);
  assert.equal(existsSync(chromeLock), true); assert.equal(existsSync(lockPath), true);
  assert.equal(manager.inspect(fixture.selection).code, 'BROWSER_SESSION_RUNNING');
  assert.throws(() => manager.acquire(fixture.selection), error => error.code === 'BROWSER_SESSION_LOCKED');
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).sessionId, first.sessionId);
  assert.equal(manager.release(first), true); assert.equal(existsSync(chromeLock), true);
});

test('managed session owns one new window and cleanup never closes pre-existing user windows', async () => {
  const fixture = chromeFixture(); const lockManager = new BrowserSessionManager({ lockPath: path.join(fixture.root, 'managed.lock'), clock });
  const calls = []; const windowDriver = {
    async openWindow(options) { calls.push(`open:${options.sessionKind}`); return { windowId: 99, sessionKind: options.sessionKind, preexistingWindowIds: [10, 11] }; },
    async closeWindow(windowId) { calls.push(`close:${windowId}`); },
  };
  const managed = new ManagedBrowserSession({ lockManager, windowDriver, sessionName: 'career_ops' });
  const session = await managed.acquire(fixture.selection);
  const lock = JSON.parse(readFileSync(lockManager.lockPath, 'utf8'));
  assert.equal(lock.state, 'RUNNING'); assert.equal(lock.windowId, 99); assert.equal(lock.sessionId, session.sessionId);
  await managed.release(session);
  assert.deepEqual(calls, ['open:managed_window', 'close:99']); assert.equal(existsSync(lockManager.lockPath), false);
});

test('managed session configuration requires a normal managed window', () => {
  assert.deepEqual(managedBrowserSessionConfigFromEnv({}), { sessionName: 'career_ops', sessionKind: 'managed_window' });
  assert.deepEqual(managedBrowserSessionConfigFromEnv({ BROWSER_SESSION_NAME: 'research_1', BROWSER_SESSION_KIND: 'managed_window' }), { sessionName: 'research_1', sessionKind: 'managed_window' });
  assert.throws(() => managedBrowserSessionConfigFromEnv({ BROWSER_SESSION_KIND: 'incognito' }), /must be managed_window/);
});

test('managed session releases its lock even when owned-window cleanup fails', async () => {
  const fixture = chromeFixture(); const lockManager = new BrowserSessionManager({ lockPath: path.join(fixture.root, 'cleanup.lock'), clock });
  const managed = new ManagedBrowserSession({ lockManager, windowDriver: {
    async openWindow() { return { windowId: 77, preexistingWindowIds: [1] }; },
    async closeWindow() { throw new Error('fixture close failed'); },
  } });
  const session = await managed.acquire(fixture.selection);
  await assert.rejects(() => managed.release(session), /fixture close failed/);
  assert.equal(existsSync(lockManager.lockPath), false);
});

test('macOS driver creates a normal authenticated-profile window and rejects resources not created by Career Ops', async () => {
  let opened = false; let markerUrl = ''; let launchArgs = []; const closed = [];
  const run = async (command, args) => {
    if (command === '/usr/bin/open') { opened = true; launchArgs = args; markerUrl = args.at(-1); return { stdout: '' }; }
    const source = args[1] || '';
    if (source.includes('id of every window')) return { stdout: opened ? '10, 11, 99' : '10, 11' };
    if (source.includes('mode as text')) return { stdout: `normal|${markerUrl}` };
    if (source.includes('make new tab')) return { stdout: '501' };
    if (source.includes('close window')) { closed.push(Number(args.at(-1))); return { stdout: '' }; }
    if (source.includes('close tab')) return { stdout: '' };
    return { stdout: '' };
  };
  const driver = new MacOsChromeWindowDriver({ run, sleep: async () => {}, attempts: 2, platform: 'darwin' });
  const window = await driver.openWindow({ selection: { profileDirectory: 'Default' }, sessionId: 'session-123', sessionName: 'career_ops', sessionKind: 'managed_window' });
  assert.equal(window.windowId, 99); assert.deepEqual(window.preexistingWindowIds, [10, 11]);
  assert.equal(window.sessionKind, 'managed_window'); assert.ok(launchArgs.includes('--profile-directory=Default'));
  assert.equal(launchArgs.includes('--incognito'), false); assert.match(markerUrl, /^file:\/\/\/dev\/null#career-ops-career_ops-session-123$/);
  await assert.rejects(() => driver.closeWindow(10), error => error.code === 'BROWSER_WINDOW_NOT_OWNED');
  const tabId = await driver.openTab(99, 'https://example.test/'); assert.equal(tabId, 501);
  await assert.rejects(() => driver.closeTab(99, 777), error => error.code === 'BROWSER_TAB_NOT_OWNED');
  await driver.closeTab(99, 501); await driver.closeWindow(99);
  assert.deepEqual(closed, [99]);
});

test('macOS driver tolerates transient Chrome Apple Events reconnection after opening its window', async () => {
  let opened = false; let transient = true; let markerUrl = '';
  const run = async (command, args) => {
    if (command === '/usr/bin/open') { opened = true; markerUrl = args.at(-1); return { stdout: '' }; }
    const source = args[1] || '';
    if (source.includes('id of every window')) {
      if (opened && transient) { transient = false; const error = new Error('La conexión no es válida. (-609)'); error.stderr = error.message; throw error; }
      return { stdout: opened ? '10, 99' : '10' };
    }
    if (source.includes('mode as text')) return { stdout: `normal|${markerUrl}` };
    if (source.includes('close window')) return { stdout: '' };
    return { stdout: '' };
  };
  const driver = new MacOsChromeWindowDriver({ run, sleep: async () => {}, attempts: 2, connectionRetries: 2, platform: 'darwin' });
  const window = await driver.openWindow({ selection: { profileDirectory: 'Default' }, sessionId: 'session-123', sessionKind: 'managed_window' });
  assert.equal(window.windowId, 99); await driver.closeWindow(99);
});

test('macOS driver treats Chrome error -600 as zero windows before launching', async () => {
  let opened = false; let markerUrl = '';
  const run = async (command, args) => {
    if (command === '/usr/bin/open') { opened = true; markerUrl = args.at(-1); return { stdout: '' }; }
    const source = args[1] || '';
    if (source.includes('id of every window')) {
      if (!opened) { const error = new Error('La aplicación no está abierta. (-600)'); error.stderr = error.message; throw error; }
      return { stdout: '99' };
    }
    if (source.includes('mode as text')) return { stdout: `normal|${markerUrl}` };
    if (source.includes('close window')) return { stdout: '' };
    return { stdout: '' };
  };
  const driver = new MacOsChromeWindowDriver({ run, sleep: async () => {}, attempts: 2, platform: 'darwin' });
  const window = await driver.openWindow({ selection: { profileDirectory: 'Default' }, sessionId: 'session-600', sessionKind: 'managed_window' });
  assert.equal(window.windowId, 99); assert.deepEqual(window.preexistingWindowIds, []); await driver.closeWindow(99);
});

test('macOS driver never claims or closes a concurrently-created user window', async () => {
  let opened = false; const closed = [];
  const run = async (command, args) => {
    if (command === '/usr/bin/open') { opened = true; return { stdout: '' }; }
    const source = args[1] || '';
    if (source.includes('id of every window')) return { stdout: opened ? '10, 55' : '10' };
    if (source.includes('mode as text')) return { stdout: 'normal|https://example.test/' };
    if (source.includes('close window')) { closed.push(Number(args.at(-1))); return { stdout: '' }; }
    return { stdout: '' };
  };
  const driver = new MacOsChromeWindowDriver({ run, sleep: async () => {}, attempts: 1, platform: 'darwin' });
  await assert.rejects(
    () => driver.openWindow({ selection: { profileDirectory: 'Default' }, sessionId: 'session-123', sessionKind: 'managed_window' }),
    error => error.code === 'BROWSER_WINDOW_UNVERIFIED',
  );
  assert.deepEqual(closed, []);
});

test('read-only adapter blocks mutating requests and permits retrieval methods', async () => {
  let routeHandler;
  const context = { route: async (_pattern, handler) => { routeHandler = handler; }, on() {}, close: async () => {} };
  const adapter = new PlaywrightReadOnlyAdapter({ chromiumImpl: { launchPersistentContext: async () => context } });
  await adapter.start({ userDataDir: '/fixture/chrome', profileDirectory: 'Default' });
  let outcome;
  await routeHandler({ request: () => ({ method: () => 'POST' }), abort: async reason => { outcome = `abort:${reason}`; }, continue: async () => { outcome = 'continue'; } });
  assert.equal(outcome, 'abort:blockedbyclient');
  await routeHandler({ request: () => ({ method: () => 'GET' }), abort: async () => { outcome = 'abort'; }, continue: async () => { outcome = 'continue'; } });
  assert.equal(outcome, 'continue');
});

test('managed adapter falls back to owned-tab URL and title evidence when DOM extraction is unavailable', async () => {
  const calls = []; const javascriptError = new Error('JavaScript unavailable'); javascriptError.code = 'BROWSER_JAVASCRIPT_UNAVAILABLE';
  const driver = {
    async openTab(windowId, url) { calls.push(`open:${windowId}:${url}`); return 501; },
    async executeJavaScript() { throw javascriptError; },
    async readTabMetadata() { return { title: 'Recommended jobs', url: 'https://www.linkedin.com/jobs/collections/recommended/' }; },
    async closeTab(windowId, tabId) { calls.push(`close:${windowId}:${tabId}`); },
  };
  const adapter = new ManagedChromeResearchAdapter({ clock, sleep: async () => {}, timeoutMs: 100 });
  await adapter.start({ windowDriver: driver, windowId: 99 });
  const result = await adapter.read({ task: { kind: 'SESSION_VALIDATION', source: 'linkedin', url: 'https://www.linkedin.com/jobs/collections/recommended/' } });
  assert.equal(result.finalUrl, 'https://www.linkedin.com/jobs/collections/recommended/');
  assert.equal(result.findings[0].extractionMethod, 'direct'); assert.equal(result.findings[0].evidence[0].field, 'page_title');
  assert.deepEqual(calls, ['open:99:https://www.linkedin.com/jobs/collections/recommended/', 'close:99:501']);
});

test('managed adapter waits past the initial about:blank before DOM extraction', async () => {
  const metadata = [
    { title: '', url: 'about:blank', loading: false },
    { title: 'LinkedIn', url: 'https://www.linkedin.com/jobs/collections/recommended/', loading: false },
  ];
  let javascriptCalls = 0; const driver = {
    async openTab() { return 501; },
    async readTabMetadata() { return metadata.shift() || { title: 'LinkedIn', url: 'https://www.linkedin.com/jobs/collections/recommended/', loading: false }; },
    async executeJavaScript(_windowId, _tabId, source) {
      javascriptCalls++;
      if (source === 'document.readyState') return 'complete';
      return JSON.stringify({ title: 'LinkedIn', text: 'Recommended jobs', links: [], finalUrl: 'https://www.linkedin.com/jobs/collections/recommended/' });
    },
    async closeTab() {},
  };
  const adapter = new ManagedChromeResearchAdapter({ clock, sleep: async () => {}, timeoutMs: 100 });
  await adapter.start({ windowDriver: driver, windowId: 99 });
  const result = await adapter.read({ task: { kind: 'SESSION_VALIDATION', source: 'linkedin', url: 'https://www.linkedin.com/jobs/collections/recommended/' } });
  assert.equal(result.finalUrl, 'https://www.linkedin.com/jobs/collections/recommended/');
  assert.equal(result.text, 'Recommended jobs'); assert.equal(result.findings[0].extractionMethod, 'parsed');
  assert.equal(javascriptCalls, 2);
});

test('contact identity remains UNKNOWN without direct relationship evidence', () => {
  const contact = validateBrowserResearchObservation({ ...jobFinding(), entityType: 'CONTACT', data: { name: 'Someone' } });
  assert.equal(contact.data.relationshipStatus, 'UNKNOWN');
  assert.throws(() => validateBrowserResearchObservation({ ...contact, data: { relationshipStatus: 'CONFIRMED' }, evidence: [] }), /requires evidence/);
});

test('registry deduplicates repeated browser observations and retains provenance', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock }); const finding = validateBrowserResearchObservation(jobFinding());
  try {
    for (const runId of ['browser-1', 'browser-2']) {
      registry.startRun({ id: runId, type: 'browser-research', startedAt: NOW });
      registry.recordBrowserResearchResults(runId, [finding]); registry.finishRun(runId, { status: 'SUCCESS', finishedAt: NOW });
    }
    const evidence = registry.listBrowserResearchEvidence({ entityType: 'JOB' });
    assert.equal(evidence.length, 1); assert.equal(evidence[0].occurrences, 2); assert.equal(evidence[0].provenance.profile, 'jorge');
  } finally { registry.close(); }
});

test('runner persists through Registry Boundary and records unavailable-browser failure', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  try {
    const provider = new BrowserResearchProvider({ adapter: { async read() { return { text: 'job', findings: [jobFinding()] }; }, async close() {} }, clock });
    const selection = { profile: 'jorge', mode: 'research_only', profileDirectory: 'Default' };
    const success = await runBrowserResearch({ registry, selection, provider, tasks: [{ id: 'one', source: 'linkedin', url: jobFinding().sourceUrl }], sessionManager: { acquire: value => value, release() {} }, runId: 'runner-success', clock });
    assert.equal(success.status, 'SUCCESS'); assert.equal(success.browser.jobs, 1); assert.equal(registry.listBrowserResearchEvidence({}).length, 1);
    const failed = await runBrowserResearch({ registry, selection, provider, tasks: [], sessionManager: { acquire() { const error = new Error('Chrome unavailable'); error.code = 'BROWSER_PROFILE_UNAVAILABLE'; throw error; }, release() {} }, runId: 'runner-failed', clock });
    assert.equal(failed.status, 'FAILED'); assert.equal(failed.failures[0].code, 'BROWSER_PROFILE_UNAVAILABLE');
  } finally { registry.close(); }
});

test('task failure still cleans the owned window and Career Ops session lock', async () => {
  const fixture = chromeFixture(); const registry = new JobRegistry({ dbPath: ':memory:', clock });
  const lockManager = new BrowserSessionManager({ lockPath: path.join(fixture.root, 'runner-cleanup.lock'), clock });
  const closed = [];
  const sessionManager = new ManagedBrowserSession({ lockManager, windowDriver: {
    async openWindow() { return { windowId: 88, preexistingWindowIds: [1, 2] }; },
    async closeWindow(windowId) { closed.push(windowId); },
  } });
  const adapter = { async start() {}, async read() { throw new Error('fixture tab failed'); }, async close() {} };
  const provider = new BrowserResearchProvider({ adapter, clock });
  try {
    const result = await runBrowserResearch({ registry, selection: fixture.selection, provider, tasks: [{ id: 'failure', source: 'web', url: 'https://example.test/' }], sessionManager, runId: 'managed-cleanup', clock });
    assert.equal(result.status, 'PARTIAL'); assert.deepEqual(closed, [88]); assert.equal(existsSync(lockManager.lockPath), false);
  } finally { registry.close(); }
});

test('CLI dry-run plans tasks without profile access, navigation, locks, or registry writes', () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const result = spawnSync(process.execPath, ['browser-research.mjs', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, BROWSER_PROFILE: 'jorge', BROWSER_MODE: 'research_only', BROWSER_USER_DATA_DIR: '' } });
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'DRY_RUN'); assert.equal(output.navigationStarted, false); assert.deepEqual(output.writes, []); assert.ok(output.tasks.length > 0);
});

test('scheduled Browser Research waits for 16:00 Mexico City and runs at most once per local day', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  try {
    assert.equal(shouldRunBrowserResearchScheduled({ registry, now: new Date('2026-08-23T21:59:00Z') }).reason, 'BEFORE_RESEARCH_WINDOW');
    assert.equal(shouldRunBrowserResearchScheduled({ registry, now: new Date(NOW) }).run, true);
    registry.startRun({ id: 'scheduled-browser', type: 'browser-research', startedAt: NOW });
    registry.finishRun('scheduled-browser', { status: 'SUCCESS', finishedAt: NOW });
    assert.equal(shouldRunBrowserResearchScheduled({ registry, now: new Date('2026-08-23T23:00:00Z') }).reason, 'BROWSER_RESEARCH_ALREADY_RAN');
  } finally { registry.close(); }
});
