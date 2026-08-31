import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createSqliteBackup, validateBackup } from '../operations/backup.mjs';
import { validateOperationalConfig, validateStartupServiceAccess } from '../operations/config-validation.mjs';
import { runHealthCheck } from '../operations/health.mjs';
import { installLaunchAgent, renderApplicationEnrichmentLaunchAgent, renderBrowserResearchLaunchAgent, renderLaunchAgent } from '../operations/launch-agent.mjs';
import { LocalOperationalLogger } from '../operations/logging.mjs';
import { shouldRunScheduled } from '../operations/schedule.mjs';
import { validateBrowserResearchObservation } from '../research/browser-research-provider.mjs';
import { CURRENT_SCHEMA_VERSION, JobRegistry } from '../registry/job-registry.mjs';

const NOW = '2026-08-23T14:31:00.000Z';
const clock = () => new Date(NOW);

function operationalFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-hardening-'));
  for (const relative of ['cv.md', 'config/profile.yml', 'portals.yml', 'candidate/manifest.yml']) {
    const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'fixture\n');
  }
  const envFile = path.join(root, '.env'); writeFileSync(envFile, 'FIXTURE=1\n', { mode: 0o600 }); chmodSync(envFile, 0o600);
  const adcPath = path.join(root, 'application_default_credentials.json');
  writeFileSync(adcPath, JSON.stringify({ type: 'authorized_user', client_id: 'fixture-client', client_secret: 'fixture-secret', refresh_token: 'fixture-refresh' }), { mode: 0o600 });
  const chromeRoot = path.join(root, 'Chrome'); mkdirSync(path.join(chromeRoot, 'Default'), { recursive: true });
  writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Jorge' } } } }));
  const dbPath = path.join(root, 'data', 'career.db');
  const registry = new JobRegistry({ dbPath, clock });
  registry.startOperationalRun({ id: 'operation-1', startedAt: NOW });
  registry.finishOperationalRun('operation-1', { status: 'SUCCESS', finishedAt: NOW, summary: { ok: true }, sheetSynced: true });
  registry.recordSheetSync({ spreadsheetId: 'sheet-test', direction: 'PUSH', projectionHash: 'hash-test', syncedAt: NOW });
  registry.close();
  const env = {
    CAREER_OPS_SHEET_ID: 'sheet-test', GOOGLE_SHEETS_AUTH_MODE: 'application_default', GOOGLE_APPLICATION_CREDENTIALS: adcPath,
    BROWSER_PROFILE: 'jorge', BROWSER_MODE: 'research_only', BROWSER_USER_DATA_DIR: chromeRoot,
    CAREER_OPS_NOTIFICATIONS_ENABLED: 'true', CAREER_OPS_EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 'fixture-key', CAREER_OPS_EMAIL_FROM: 'Career Ops <career@brunova.mx>',
    CAREER_OPS_EMAIL_TO: 'jorgeaveraf@gmail.com',
    CANDIDATE_GMAIL_CLIENT_ID: 'candidate-client', CANDIDATE_GMAIL_CLIENT_SECRET: 'candidate-secret',
    CANDIDATE_GMAIL_REFRESH_TOKEN: 'candidate-refresh', CAREER_OPS_COMMAND_SUBSCRIBER_PROVIDER: 'command_gateway_pull',
    LINKEDIN_OUTREACH_ENABLED: 'true', APPLICATION_BROWSER_PROFILE: 'jorge',
    APPLICATION_BROWSER_MODE: 'application_submit', APPLICATION_BROWSER_USER_DATA_DIR: chromeRoot,
    PLATFORM_SIGNUP_GMAIL_READY: 'true',
  };
  return { root, dbPath, env };
}

test('health reports a configured local system as healthy', async () => {
  const fixture = operationalFixture();
  const result = await runHealthCheck({
    projectRoot: fixture.root, dbPath: fixture.dbPath, env: fixture.env, clock,
    statfs: () => ({ bavail: 10_000, bsize: 1024 * 1024 }), minimumFreeMb: 100,
    tokenProvider: { async getAccessToken() { return 'fixture-token'; } },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ spreadsheetId: 'sheet-test' }) }),
    browserWindowDriver: { async listWindowIds() { return [1, 2]; } },
    candidateGmailTransport: { async boundedRead() { return { status: 'READY', sender: 'jorgeaveraf@gmail.com', messagesInspected: 1, resultSizeEstimate: 1 }; } },
    commandSubscriberInspector: async () => true,
  });
  assert.equal(result.status, 'HEALTHY'); assert.equal(result.healthy, true);
  assert.equal(result.checks.find(item => item.name === 'Database').status, 'OK');
  assert.equal(result.checks.find(item => item.name === 'Configuration').status, 'OK');
  assert.equal(result.checks.find(item => item.name === 'Browser Session Kind').detail, 'managed_window');
  assert.equal(result.facts.latestOperationalRun.status, 'SUCCESS');
});

test('health and startup configuration detect missing required settings', async () => {
  const fixture = operationalFixture();
  const config = validateOperationalConfig({ projectRoot: fixture.root, dbPath: fixture.dbPath, env: {}, requireDatabase: true });
  assert.equal(config.ok, false);
  assert.ok(config.errors.some(item => item.code === 'SHEET_ID_MISSING'));
  assert.ok(config.errors.some(item => item.code === 'GOOGLE_AUTH_MODE_MISSING'));
  const health = await runHealthCheck({ projectRoot: fixture.root, dbPath: fixture.dbPath, env: {}, statfs: () => ({ bavail: 10_000, bsize: 1024 * 1024 }) });
  assert.equal(health.status, 'UNHEALTHY');
});

test('health reports an active Career Ops managed session without claiming user windows', async () => {
  const fixture = operationalFixture(); const lockPath = path.join(fixture.root, 'data', 'browser', '.careerops-session.lock');
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ version: 2, sessionId: 'active-session', token: 'fixture', pid: process.pid, state: 'RUNNING', windowId: 99 }));
  const result = await runHealthCheck({
    projectRoot: fixture.root, dbPath: fixture.dbPath, env: { ...fixture.env, BROWSER_SESSION_LOCK: lockPath }, clock,
    statfs: () => ({ bavail: 10_000, bsize: 1024 * 1024 }), minimumFreeMb: 100,
    tokenProvider: { async getAccessToken() { return 'fixture-token'; } },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ spreadsheetId: 'sheet-test' }) }),
    browserWindowDriver: { async listWindowIds() { return [1, 2, 99]; } },
  });
  assert.equal(result.checks.find(item => item.name === 'Career Ops Session').detail, 'RUNNING');
  assert.equal(result.checks.find(item => item.name === 'User Chrome Windows').detail, 'NOT_MANAGED (2 detected)');
});

test('startup service preflight verifies Sheet access without writing', async () => {
  const fixture = operationalFixture(); let request;
  const tokenProvider = { async getAccessToken() { return 'fixture-token'; } };
  const result = await validateStartupServiceAccess({ env: fixture.env, tokenProvider, fetchImpl: async (url, options) => {
    request = { url, options }; return { ok: true, status: 200, json: async () => ({ spreadsheetId: 'sheet-test' }) };
  } });
  assert.equal(result.ok, true); assert.match(request.url, /fields=spreadsheetId/);
  assert.equal(request.options.headers.Authorization, 'Bearer fixture-token');
  await assert.rejects(() => validateStartupServiceAccess({ env: fixture.env, tokenProvider, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }), error => error.code === 'SHEETS_ACCESS_UNAVAILABLE');
});

test('backup creates a private, valid SQLite snapshot and applies retention', async () => {
  const fixture = operationalFixture(); const outputDir = path.join(fixture.root, 'backups');
  let minute = 0;
  for (let index = 0; index < 3; index++) {
    minute++;
    await createSqliteBackup({ dbPath: fixture.dbPath, outputDir, keep: 2, clock: () => new Date(`2026-08-23T15:0${minute}:00.000Z`) });
  }
  const files = (await import('fs')).readdirSync(outputDir).filter(name => name.endsWith('.db'));
  assert.equal(files.length, 2);
  for (const file of files) {
    const absolute = path.join(outputDir, file); const validation = validateBackup(absolute);
    assert.equal(validation.valid, true); assert.equal(validation.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(statSync(absolute).mode & 0o777, 0o600);
  }
});

test('restore validation rejects a non-SQLite file and accepts a created backup', async () => {
  const fixture = operationalFixture(); const outputDir = path.join(fixture.root, 'backups');
  const created = await createSqliteBackup({ dbPath: fixture.dbPath, outputDir, keep: 1, clock });
  assert.equal(validateBackup(created.destination).valid, true);
  const invalid = path.join(fixture.root, 'invalid.db'); writeFileSync(invalid, 'not sqlite');
  assert.equal(validateBackup(invalid).valid, false);
});

test('LaunchAgent generation contains the scheduler contract and installs idempotently', () => {
  const fixture = operationalFixture(); const destination = path.join(fixture.root, 'Library', 'LaunchAgents', 'com.careerops.daily.plist');
  const plist = renderLaunchAgent({ projectRoot: fixture.root, npmPath: '/fixture/bin/npm', hour: 16, minute: 0, logsRoot: path.join(fixture.root, 'logs') });
  assert.match(plist, /<string>com\.careerops\.daily<\/string>/);
  assert.match(plist, /<string>daily:auto<\/string>/); assert.match(plist, /<string>--scheduled<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>16<\/integer>/); assert.match(plist, /<key>Minute<\/key><integer>0<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/); assert.match(plist, /launchd\.stderr\.log/);
  const first = installLaunchAgent({ plist, destination, logsRoot: path.join(fixture.root, 'logs') });
  const second = installLaunchAgent({ plist, destination, logsRoot: path.join(fixture.root, 'logs') });
  assert.equal(first.changed, true); assert.equal(second.changed, false); assert.equal(second.existing, true);
  assert.equal(readFileSync(destination, 'utf8'), plist); assert.equal(statSync(destination).mode & 0o777, 0o600);
});

test('Browser Research LaunchAgent is separate, read-only-commanded, and scheduled at 15:30', () => {
  const fixture = operationalFixture();
  const plist = renderBrowserResearchLaunchAgent({ projectRoot: fixture.root, npmPath: '/fixture/bin/npm', logsRoot: path.join(fixture.root, 'logs') });
  assert.match(plist, /<string>com\.careerops\.browser-research<\/string>/);
  assert.match(plist, /<string>browser:research<\/string>/);
  assert.match(plist, /<string>--scheduled<\/string>/); assert.match(plist, /<string>--json<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>15<\/integer>/);
  assert.match(plist, /<key>Minute<\/key><integer>30<\/integer>/);
  assert.match(plist, /logs\/browser\/discovery\/launchd\.stdout\.log/);
});

test('Application Enrichment LaunchAgent runs bounded preparation at 17:00 and never application execution', () => {
  const fixture = operationalFixture();
  const plist = renderApplicationEnrichmentLaunchAgent({ projectRoot: fixture.root, npmPath: '/fixture/bin/npm', logsRoot: path.join(fixture.root, 'logs') });
  assert.match(plist, /<string>com\.careerops\.application-enrichment<\/string>/);
  assert.match(plist, /<string>[^<]*application-enrich\.mjs<\/string>/); assert.match(plist, /<string>drain<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><false\/>/);
  assert.doesNotMatch(plist, /application:execute|APPROVE_TO_APPLY/);
  assert.match(plist, /<key>Hour<\/key><integer>17<\/integer>/); assert.match(plist, /<key>Minute<\/key><integer>0<\/integer>/);
});

test('scheduled guard skips before its window and prevents a second run on the same local day', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  try {
    assert.equal(shouldRunScheduled({ registry, now: new Date('2026-08-23T14:29:00Z'), hour: 8, minute: 30 }).reason, 'BEFORE_SCHEDULE');
    assert.equal(shouldRunScheduled({ registry, now: new Date(NOW), hour: 8, minute: 30 }).run, true);
    registry.startOperationalRun({ id: 'today', startedAt: NOW });
    registry.finishOperationalRun('today', { status: 'SUCCESS', finishedAt: NOW });
    assert.equal(shouldRunScheduled({ registry, now: new Date('2026-08-23T16:00:00Z'), hour: 8, minute: 30 }).reason, 'ALREADY_RAN_TODAY');
  } finally { registry.close(); }
});

test('local logs are structured, private, and separated by category', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-logs-')); const logger = new LocalOperationalLogger({ root, clock });
  const daily = logger.write('daily', 'run', { status: 'SUCCESS' }); const error = logger.write('errors', 'failure', { code: 'FIXTURE' });
  assert.match(readFileSync(daily, 'utf8'), /"event":"run"/); assert.match(readFileSync(error, 'utf8'), /"code":"FIXTURE"/);
  assert.equal(statSync(daily).mode & 0o077, 0);
});

test('browser research boundary accepts evidence but rejects actions', () => {
  const observation = { entityType: 'COMPANY', source: 'company-site', sourceUrl: 'https://company.example/research', retrievedAt: NOW, extractionMethod: 'direct', confidence: 'high', data: { company: 'Example' }, evidence: [{ field: 'company' }], provenance: { mode: 'RESEARCH_ONLY', profile: 'jorge', actions: [] } };
  assert.equal(validateBrowserResearchObservation(observation).entityType, 'COMPANY');
  assert.throws(() => validateBrowserResearchObservation({ ...observation, provenance: { mode: 'RESEARCH_ONLY', actions: ['message'] } }), /cannot contain performed actions/);
});

test('daily command compatibility and hardening scripts remain exposed', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const command of ['daily', 'daily:auto', 'rank', 'health', 'backup', 'launch-agent', 'browser:research', 'browser:launch-agent']) assert.ok(pkg.scripts[command]);
});
