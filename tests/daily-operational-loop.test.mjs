import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { runOperationalLoop } from '../automation/operational-loop.mjs';
import { buildEmailMessage, MemoryNotificationProvider, ResendEmailProvider } from '../automation/notification-provider.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const NOW = '2026-08-23T08:00:00.000Z';
const ROOT = new URL('..', import.meta.url).pathname;
const clock = () => new Date(NOW);
const successfulDaily = ({ runId }) => Promise.resolve({
  status: 'SUCCESS', exitCode: 0,
  summary: {
    run: { id: runId, status: 'SUCCESS' },
    discovery: { observations: 8, newJobs: 3, changedJobs: 1 }, failures: [],
  },
});
const emptyRanking = async () => ({ processed: 0, eligible: 0, shortlisted: 0, shortlistedJobIds: [], recommendations: [] });
const emptyEvaluation = async () => ({ completed: 0, apply: 0, evaluations: [] });
const emptyPackages = async () => ({ ready: 0, packages: [] });
const syncedSheet = async () => ({ synced: true, spreadsheetId: 'sheet-test' });

function harness(overrides = {}) {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  const provider = overrides.notificationProvider === undefined ? new MemoryNotificationProvider() : overrides.notificationProvider;
  return {
    registry, provider,
    options: {
      id: overrides.id || 'operational-run-1', registry, clock, projectRoot: ROOT,
      dailyRunner: overrides.dailyRunner || successfulDaily,
      rankStage: overrides.rankStage || emptyRanking,
      evaluationStage: overrides.evaluationStage || emptyEvaluation,
      packageStage: overrides.packageStage || emptyPackages,
      sheetStage: overrides.sheetStage || syncedSheet,
      notificationProvider: provider,
      dashboardUrl: 'https://docs.google.com/spreadsheets/d/sheet-test/edit',
    },
  };
}

test('complete operational run invokes every stage and persists its structured summary', async () => {
  const calls = [];
  const h = harness({
    rankStage: async () => { calls.push('rank'); return { processed: 2, eligible: 1, shortlisted: 0, shortlistedJobIds: [], recommendations: [] }; },
    evaluationStage: async () => { calls.push('evaluate'); return emptyEvaluation(); },
    packageStage: async () => { calls.push('package'); return emptyPackages(); },
    sheetStage: async () => { calls.push('sheet'); return syncedSheet(); },
  });
  try {
    const result = await runOperationalLoop(h.options);
    assert.equal(result.status, 'SUCCESS'); assert.equal(result.exitCode, 0);
    assert.deepEqual(calls, ['rank', 'evaluate', 'package', 'sheet']);
    assert.equal(result.summary.discovery.newJobs, 3);
    assert.equal(result.summary.eligibility.eligible, 1);
    assert.equal(result.summary.sheet.synced, true);
    assert.equal(h.registry.getOperationalRun('operational-run-1').status, 'SUCCESS');
  } finally { h.registry.close(); }
});

test('no changes completes without sending email', async () => {
  const h = harness();
  try {
    const result = await runOperationalLoop(h.options);
    assert.equal(result.summary.notification.required, false);
    assert.equal(result.summary.notification.status, 'NOT_REQUIRED');
    assert.equal(h.provider.messages.length, 0);
  } finally { h.registry.close(); }
});

test('a new shortlist does not generate a run-level activity email', async () => {
  const h = harness({ rankStage: async () => ({
    processed: 1, eligible: 1, shortlisted: 1, shortlistedJobIds: ['job-1'],
    recommendations: [{ jobId: 'job-1', company: 'Example AI', role: 'AI Platform Engineer', priority: 92, reasons: ['Strong AI systems match'], jobUrl: 'https://jobs.example.test/1' }],
  }) });
  try {
    const result = await runOperationalLoop(h.options);
    assert.equal(result.summary.notification.sent, false);
    assert.deepEqual(result.summary.notification.reasons, []);
    assert.equal(h.provider.messages.length, 0);
  } finally { h.registry.close(); }
});

test('package generation alone does not bypass the canonical ready event', async () => {
  const h = harness({ packageStage: async () => ({ ready: 1, packages: [{ jobId: 'job-1' }] }) });
  try {
    const result = await runOperationalLoop(h.options);
    assert.deepEqual(result.summary.notification.reasons, []);
    assert.equal(h.provider.messages.length, 0);
  } finally { h.registry.close(); }
});

test('active-set quality activity is suppressed as notification noise', async () => {
  const h = harness({ rankStage: async () => ({ processed: 4, eligible: 0, activeSet: 4, shortlisted: 0, shortlistedJobIds: [], recommendations: [] }) });
  try {
    const result = await runOperationalLoop(h.options);
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(result.summary.notification.reasons, []);
    assert.equal(h.provider.messages.length, 0);
  } finally { h.registry.close(); }
});

test('daily discovery failure stays observable without a duplicate summary email', async () => {
  const h = harness({ dailyRunner: async () => ({ status: 'FAILED', exitCode: 1, summary: null }) });
  try {
    const result = await runOperationalLoop(h.options);
    assert.equal(result.status, 'FAILED');
    assert.ok(result.summary.errors.some(item => item.code === 'DAILY_RUN_FAILED' && item.severity === 'ATTENTION'));
    assert.equal(h.provider.messages.length, 0);
  } finally { h.registry.close(); }
});

test('replaying the same operational run remains notification-quiet', async () => {
  const h = harness({ rankStage: async () => ({ processed: 1, eligible: 1, shortlisted: 1, shortlistedJobIds: [], recommendations: [] }) });
  try {
    const first = await runOperationalLoop(h.options);
    const second = await runOperationalLoop(h.options);
    assert.equal(first.summary.notification.sent, false);
    assert.equal(second.existing, true);
    assert.equal(h.provider.messages.length, 0);
    assert.equal(h.registry.getNotificationDelivery('operational-run-1'), null);
  } finally { h.registry.close(); }
});

test('email formatting includes subject, recommendations, dashboard, and system status', () => {
  const summary = {
    run: { id: 'run-1', status: 'SUCCESS' }, discovery: { newJobs: 3 }, ranking: { shortlisted: 1 },
    packages: { ready: 1 }, errors: [], dashboardUrl: 'https://docs.google.com/spreadsheets/d/test/edit',
    topRecommendations: [{ company: 'Example AI', role: 'AI Platform Engineer', priority: 92, reasons: ['Strong AI systems match'], packageReady: true, jobUrl: 'https://jobs.example.test/1' }],
  };
  const email = buildEmailMessage(summary, { from: 'Career Ops <career@brunova.mx>', to: 'jorgeaveraf@gmail.com' });
  assert.match(email.subject, /Career Ops Daily Report — 1 opportunity requires review/);
  assert.match(email.text, /Top recommendations:/); assert.match(email.text, /Example AI/);
  assert.match(email.text, /Priority: 92/); assert.match(email.text, /Package: Ready for review/);
  assert.match(email.text, /Dashboard: https:\/\/docs\.google\.com/); assert.match(email.text, /System status: Healthy/);
});

test('email configuration uses environment inputs and never embeds credentials', async () => {
  let request;
  const provider = new ResendEmailProvider({
    apiKey: 'fixture-secret', from: 'Career Ops <career@brunova.mx>', to: 'jorgeaveraf@gmail.com',
    fetchImpl: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ id: 'email-1' }) }; },
  });
  await provider.sendSummary({ subject: 'Test', text: 'Body', idempotencyKey: 'career-ops:run-1:email' });
  assert.equal(request.options.headers.Authorization, 'Bearer fixture-secret');
  assert.equal(request.options.headers['Idempotency-Key'], 'career-ops:run-1:email');
  assert.equal(request.body.from, 'Career Ops <career@brunova.mx>');
  assert.deepEqual(request.body.to, ['jorgeaveraf@gmail.com']);
  for (const path of ['../automation/notification-provider.mjs', '../automation/operational-loop.mjs', '../daily-auto.mjs']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /fixture-secret|re_[A-Za-z0-9]{16,}/);
  }
});
