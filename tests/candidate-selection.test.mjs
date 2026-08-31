import test from 'node:test';
import assert from 'node:assert/strict';
import { CandidateSelectionEngine, buildDailyPrioritySnapshot, normalizeSelectionText } from '../candidate-selection/engine.mjs';
import { createCandidateSelectionPolicy } from '../candidate-selection/policy.mjs';

const NOW = new Date('2026-08-24T16:00:00.000Z');
const profile = {
  location: { country: 'Mexico' },
  target_roles: { primary: ['AI Systems Engineer'], alternatives: ['Senior Data Engineer'], seniority: { excluded: ['Director'], preferred: ['Senior'] } },
  search_preferences: { work_location: { accepted: ['Remote'], excluded: ['Hybrid', 'On-site'] } },
  discovery_strategy: { rejection_rules: { companies: ['BairesDev', 'lemon'], pool_signals: { action: 'penalize', priority_penalty: 25, phrases: ['talent pool'] } } },
};
const portals = {
  max_posting_age_days: 21,
  location_filter: { always_allow: ['Mexico', 'Worldwide'], block: ['US', 'United States'] },
  title_filter: { positive: ['AI Platform Engineer'], negative: ['Junior'], seniority_boost: ['Staff'] },
  country_eligibility_filter: { exclusionary: ['us only'], inclusive: ['mexico', 'worldwide'] },
  content_filter: { negative: ['night shift'] },
};
const policy = overrides => createCandidateSelectionPolicy(profile, portals, overrides);

function candidate(id, overrides = {}) {
  return {
    jobId: `job-${id}`, observationId: `obs-${id}`,
    title: 'Senior AI Systems Engineer', company: `Company ${id}`, location: 'Remote, Worldwide',
    description: 'Build production AI systems, data platforms, APIs, and reliable event-driven services. '.repeat(4),
    provider: 'greenhouse-api', sourceUrl: `https://jobs.example/${id}`,
    postedAt: '2026-08-23T00:00:00.000Z', firstObservedAt: '2026-08-23T00:00:00.000Z',
    observedInRun: true, humanState: {}, ...overrides,
  };
}

function engine(overrides = {}) {
  return new CandidateSelectionEngine({ policy: policy(overrides), clock: () => NOW });
}

test('selection reduces 6,000 raw observations to 70 qualified candidates without filling capacity', () => {
  const good = Array.from({ length: 70 }, (_, index) => candidate(`good-${index}`));
  const noise = Array.from({ length: 5930 }, (_, index) => candidate(`noise-${index}`, { title: 'Account Executive' }));
  const result = engine().select({ candidates: [...noise, ...good] });
  assert.equal(result.counts.raw, 6000);
  assert.equal(result.counts.REJECT, 5930);
  assert.equal(result.activeCandidates.length, 70);
  assert.equal(result.fillToCapacity, false);
});

test('150 good candidates are capped at 100 by quality, not FIFO arrival order', () => {
  const older = Array.from({ length: 50 }, (_, index) => candidate(`old-${index}`, {
    postedAt: '2026-08-05T00:00:00.000Z', firstObservedAt: '2026-08-05T00:00:00.000Z',
  }));
  const best = Array.from({ length: 100 }, (_, index) => candidate(`best-${index}`));
  const result = engine().select({ candidates: [...older, ...best] });
  assert.equal(result.activeCandidates.length, 100);
  assert.ok(result.activeCandidates.every(item => item.jobId.startsWith('job-best-')));
});

test('source diversity prevents one provider alias from monopolizing the active set', () => {
  const dominant = Array.from({ length: 500 }, (_, index) => candidate(`gh-${index}`, { provider: index % 2 ? 'greenhouse' : 'greenhouse-api' }));
  const alternative = Array.from({ length: 20 }, (_, index) => candidate(`indeed-${index}`, { provider: 'browser:indeed' }));
  const result = engine().select({ candidates: [...dominant, ...alternative] });
  assert.equal(result.activeCandidates.filter(item => item.sourceKey === 'greenhouse').length, 50);
  assert.equal(result.activeCandidates.filter(item => item.sourceKey === 'browser:indeed').length, 20);
});

test('prior active candidate carries over when still qualified and not observed in current run', () => {
  const item = candidate('carry', { observedInRun: false });
  const result = engine().select({ candidates: [item], previousCandidates: [{ jobId: item.jobId, observationId: item.observationId, state: 'ACTIVE', rank: 4 }] });
  assert.equal(result.activeCandidates[0].state, 'CARRYOVER');
  assert.equal(result.activeCandidates[0].previousRank, 4);
});

test('human reject and applied state are terminal and never selected', () => {
  const rejected = candidate('reject', { humanState: { humanDecision: 'REJECT' } });
  const applied = candidate('applied', { humanState: { applicationStatus: 'APPLIED' } });
  const result = engine().select({ candidates: [rejected, applied] });
  assert.equal(result.activeCandidates.length, 0);
  assert.deepEqual(result.transitions.map(item => item.state).sort(), ['ACTED', 'DISCARDED']);
});

test('Lemon.io identity is rejected across providers without matching unrelated companies', () => {
  const result = engine().select({ candidates: [
    candidate('lemon-a', { company: 'Lemon.io', provider: 'greenhouse' }),
    candidate('lemon-b', { company: 'lemon.io', provider: 'browser:linkedin' }),
    candidate('other', { company: 'Lemonade', provider: 'lever' }),
  ] });
  assert.deepEqual(result.decisions.filter(item => item.reasons.includes('hard_reject_company')).map(item => item.jobId).sort(), ['job-lemon-a', 'job-lemon-b']);
  assert.ok(result.activeCandidates.some(item => item.jobId === 'job-other'));
});

test('explicit Remote US and hybrid locations remain hard stops', () => {
  const us = candidate('us', { location: 'Remote, US' });
  const hybrid = candidate('hybrid', { location: 'Remote / Hybrid, Mexico' });
  const result = engine().select({ candidates: [us, hybrid] });
  assert.equal(result.activeCandidates.length, 0);
  assert.ok(result.decisions[0].reasons.includes('explicit_location_exclusion'));
  assert.ok(result.decisions[1].reasons.includes('explicit_non_remote_role'));
});

test('17 strong candidates remain 17 and TOP 10 never exceeds ten', () => {
  const candidates = Array.from({ length: 17 }, (_, index) => candidate(index));
  const selection = engine().select({ candidates });
  const assessments = selection.activeCandidates.map((item, index) => ({
    jobId: item.jobId, eligibilityStatus: 'ELIGIBLE', candidateFitScore: 90 - index,
    opportunityScore: 88 - index, finalPriorityScore: 95 - index, decision: 'SHORTLIST',
    reasons: ['strong fit'], confidence: 'high',
  }));
  const snapshot = buildDailyPrioritySnapshot({
    runId: 'run', snapshotDate: '2026-08-24', activeCandidates: selection.activeCandidates,
    assessments, policy: policy(),
  });
  assert.equal(selection.activeCandidates.length, 17);
  assert.equal(snapshot.top10.length, 10);
});

test('confirmed pool-only candidates are rejected before the active set', () => {
  const selection = engine({ minimumSelectionScore: 40 }).select({ candidates: [candidate('pool', { title: 'Join our talent pool', description: 'Future opportunities.' })] });
  assert.equal(selection.activeCandidates.length, 0);
  assert.equal(selection.decisions[0].poolOnly, true);
  assert.equal(selection.decisions[0].outcome, 'REJECT');
});

test('a better candidate changes the deterministic daily rank and records movement', () => {
  const active = [candidate('a'), candidate('b')].map((item, index) => ({ ...item, preliminaryScore: 90 - index, poolOnly: false, evidenceWeak: false }));
  const assessments = [
    { jobId: active[0].jobId, eligibilityStatus: 'ELIGIBLE', candidateFitScore: 90, opportunityScore: 90, finalPriorityScore: 80, decision: 'SHORTLIST', reasons: [], confidence: 'high' },
    { jobId: active[1].jobId, eligibilityStatus: 'ELIGIBLE', candidateFitScore: 95, opportunityScore: 95, finalPriorityScore: 95, decision: 'SHORTLIST', reasons: [], confidence: 'high' },
  ];
  const snapshot = buildDailyPrioritySnapshot({ runId: 'run', snapshotDate: '2026-08-24', activeCandidates: active, assessments, previousRanks: new Map([[active[1].jobId, 2]]), policy: policy() });
  assert.equal(snapshot.entries[0].jobId, active[1].jobId);
  assert.equal(snapshot.entries[0].movement, 'UP_1');
});

test('accent normalization is deterministic for selection rules', () => {
  assert.equal(normalizeSelectionText('  Automatización—de DATOS  '), 'automatizacion de datos');
});
