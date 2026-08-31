import test from 'node:test';
import assert from 'node:assert/strict';
import { JobRegistry } from '../registry/job-registry.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { matchPreferenceSignals } from '../human-decision/rejection-intelligence.mjs';
import { rankOpportunity } from '../intelligence/ranking-engine.mjs';
import { buildReadmeValues } from '../human-control-plane/sheet-ux.mjs';

const NOW = '2026-08-25T12:00:00.000Z';

function fixtureRegistry() { return new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) }); }

function addActiveJob(registry, suffix, { company = `Company ${suffix}`, role = 'AI Platform Engineer', description = 'Build AI platform systems for international customers.' } = {}) {
  const runId = `run-${suffix}`;
  registry.startRun({ id: runId });
  const observed = registry.recordObservation(runId, {
    provider: 'fixture', externalId: suffix, sourceUrl: `https://jobs.example.test/${suffix}`,
    title: role, company, location: 'Remote Mexico', description, retrievedAt: NOW,
  });
  registry.recordCandidateSelection(runId, {
    rulesVersion: 'fixture', policyHash: 'fixture-policy', capacity: 100, threshold: 0,
    counts: { raw: 1, PASS: 1, REJECT: 0, UNKNOWN: 0, active: 1 },
    decisions: [{ jobId: observed.jobId, observationId: observed.observationId, outcome: 'PASS', preliminaryScore: 90, freshnessDays: 0, source: 'fixture', sourceKey: 'fixture', reasons: [], evidenceRefs: [], poolOnly: false, evidenceWeak: false }],
    activeCandidates: [{ jobId: observed.jobId, observationId: observed.observationId, state: 'ACTIVE', stateReason: 'fixture', preliminaryScore: 90, freshnessDays: 0, source: 'fixture', sourceKey: 'fixture', previousRank: null, selectionRank: 1 }],
    transitions: [],
  });
  registry.finishRun(runId);
  return observed;
}

function humanAction(jobId, field, value, suffix = field) {
  return { actionKey: `${jobId}:${suffix}:${value}`, spreadsheetId: 'sheet', tabName: 'TODAY', entityType: 'JOB', entityId: jobId, field, value, observedAt: NOW, user: 'jorge', sourceHash: `source-${suffix}` };
}

function decide(registry, jobId, decision, { notes = '', reason = '' } = {}) {
  const accepted = [];
  if (notes !== undefined) accepted.push(humanAction(jobId, 'notes', notes, `notes-${notes}`));
  if (reason) accepted.push(humanAction(jobId, 'rejection_reason', reason, `reason-${reason}`));
  accepted.push(humanAction(jobId, 'human_decision', decision, `decision-${decision}`));
  return registry.recordHumanActions({ accepted, rejected: [] });
}

test('REJECT removes an active candidate while preserving exact notes and explicit feedback', () => {
  const registry = fixtureRegistry();
  try {
    const { jobId } = addActiveJob(registry, 'reject-notes');
    const notes = 'Requires German; not useful for me.';
    decide(registry, jobId, 'REJECT', { notes, reason: 'LANGUAGE_REQUIREMENT' });
    assert.equal(registry.listActiveCandidates().some(item => item.jobId === jobId), false);
    assert.equal(registry.getHumanFieldState().find(item => item.field === 'notes').value, notes);
    const feedback = registry.listRejectionFeedback({ jobId })[0];
    assert.equal(feedback.rawNotes, notes);
    assert.equal(feedback.structuredReason, 'LANGUAGE_REQUIREMENT');
    assert.equal(feedback.humanDecision, 'REJECT');
  } finally { registry.close(); }
});

test('feedback survives control-plane reprojection after the rejected row disappears', () => {
  const registry = fixtureRegistry();
  try {
    const { jobId } = addActiveJob(registry, 'reprojection');
    decide(registry, jobId, 'REJECT', { notes: 'Not for me.' });
    const projection = buildControlPlaneProjection(registry.getControlPlaneData({ candidateScope: 'decision' }));
    assert.equal(projection.tabs.TODAY.some(row => row['Entity ID'] === jobId), false);
    assert.equal(projection.tabs.PIPELINE.some(row => row['Entity ID'] === jobId), false);
    assert.equal(registry.listRejectionFeedback({ jobId })[0].rawNotes, 'Not for me.');
  } finally { registry.close(); }
});

test('one rejection creates only observations and never a hard rule or company block', () => {
  const registry = fixtureRegistry();
  try {
    const { jobId } = addActiveJob(registry, 'one', { company: 'Acme' });
    decide(registry, jobId, 'REJECT', { reason: 'ROLE_NOT_RELEVANT' });
    const signals = registry.listPreferenceSignals();
    assert.ok(signals.length > 0);
    assert.ok(signals.every(signal => signal.level === 'OBSERVATION' && signal.scoreAdjustment === 0));
    assert.equal(signals.some(signal => signal.level === 'HARD_RULE'), false);
  } finally { registry.close(); }
});

test('three matching reasons create a stronger soft signal without automatic hard policy', () => {
  const registry = fixtureRegistry();
  try {
    for (const suffix of ['a', 'b', 'c']) {
      const { jobId } = addActiveJob(registry, suffix, { role: 'Senior Frontend Engineer' });
      decide(registry, jobId, 'REJECT', { reason: 'STACK_MISMATCH' });
    }
    const roleSignal = registry.listPreferenceSignals().find(signal => signal.scopeType === 'ROLE_FAMILY' && signal.category === 'STACK_MISMATCH');
    assert.equal(roleSignal.level, 'SOFT_SIGNAL');
    assert.equal(roleSignal.evidenceCount, 3);
    assert.equal(registry.listPreferenceSignals().some(signal => signal.level === 'HARD_RULE'), false);
  } finally { registry.close(); }
});

test('the same role family with different reasons is not combined incorrectly', () => {
  const registry = fixtureRegistry();
  try {
    for (const [suffix, reason] of [['d1', 'COMPENSATION'], ['d2', 'GEOGRAPHY'], ['d3', 'SCHEDULE']]) {
      const { jobId } = addActiveJob(registry, suffix, { role: 'AI Platform Engineer' });
      decide(registry, jobId, 'REJECT', { reason });
    }
    const roleSignals = registry.listPreferenceSignals().filter(signal => signal.scopeType === 'ROLE_FAMILY');
    assert.equal(roleSignals.length, 3);
    assert.ok(roleSignals.every(signal => signal.evidenceCount === 1 && signal.level === 'OBSERVATION'));
  } finally { registry.close(); }
});

test('NEXT_STAGE creates exactly one pending request and REJECT cancels it', () => {
  const registry = fixtureRegistry();
  try {
    const { jobId } = addActiveJob(registry, 'next');
    const action = humanAction(jobId, 'human_decision', 'NEXT_STAGE', 'next-stage');
    registry.recordHumanActions({ accepted: [action], rejected: [] });
    registry.recordHumanActions({ accepted: [action], rejected: [] });
    assert.equal(registry.listEnrichmentRequests({ status: 'PENDING', jobId }).length, 1);
    registry.recordHumanActions({ accepted: [humanAction(jobId, 'human_decision', 'REJECT', 'reject-after-next')], rejected: [] });
    assert.equal(registry.listEnrichmentRequests({ status: 'PENDING', jobId }).length, 0);
    assert.equal(registry.listEnrichmentRequests({ status: 'CANCELLED', jobId }).length, 1);
  } finally { registry.close(); }
});

test('HOLD retains the candidate as carryover and creates no enrichment request', () => {
  const registry = fixtureRegistry();
  try {
    const { jobId } = addActiveJob(registry, 'hold');
    decide(registry, jobId, 'HOLD', { notes: 'Revisit tomorrow.' });
    assert.equal(registry.listActiveCandidates().find(item => item.jobId === jobId).state, 'CARRYOVER');
    assert.equal(registry.listEnrichmentRequests({ jobId }).length, 0);
  } finally { registry.close(); }
});

test('soft human feedback adjusts ranking explanation without changing eligibility', () => {
  const signals = [{ id: 'signal-1', level: 'SOFT_SIGNAL', category: 'COMPANY_NOT_INTERESTING', scopeType: 'COMPANY', scopeValue: 'acme', evidenceCount: 4, scoreAdjustment: -8, supportingRejectionIds: ['r1', 'r2', 'r3', 'r4'] }];
  const job = { company: 'Acme', title: 'AI Platform Engineer', description: 'Flexible distributed AI platform role.', humanPreference: matchPreferenceSignals({ company: 'Acme', title: 'AI Platform Engineer' }, signals) };
  const eligibility = { status: 'ELIGIBLE', signals: { compensation: { status: 'UNKNOWN', comparison: 'not_available' } } };
  const policy = { rolePhrases: ['AI Platform Engineer'], employment: [], workPreferences: { strategicSignals: { positive: [], negative: [] } } };
  const result = rankOpportunity(job, eligibility, policy);
  assert.equal(eligibility.status, 'ELIGIBLE');
  assert.equal(result.finalPriority.humanPreferenceAdjustment, -8);
  assert.match(result.finalPriority.humanPreferenceReasons[0], /4 prior rejections/);
  assert.deepEqual(result.finalPriority.humanPreferenceEvidenceRefs.map(item => item.rejectionId), ['r1', 'r2', 'r3', 'r4']);
});

test('Sheet README explains the real V2A decisions and the NEXT_STAGE authorization boundary', () => {
  const readme = buildReadmeValues().flat().join('\n');
  for (const value of ['Human Decision', 'REJECT', 'HOLD', 'NEXT_STAGE', 'NO_ACTION', 'Queued for enrichment', 'Notes']) assert.match(readme, new RegExp(value));
  assert.match(readme, /NEXT_STAGE prepara; no autoriza un envío/i);
  assert.match(readme, /APPROVE_TO_APPLY autoriza exactamente una aplicación/i);
});
