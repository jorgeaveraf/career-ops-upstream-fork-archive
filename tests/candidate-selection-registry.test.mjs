import test from 'node:test';
import assert from 'node:assert/strict';
import { JobRegistry } from '../registry/job-registry.mjs';
import { CandidateSelectionEngine } from '../candidate-selection/engine.mjs';
import { createCandidateSelectionPolicy } from '../candidate-selection/policy.mjs';

const NOW = '2026-08-24T16:00:00.000Z';

function setup() {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  registry.startRun({ id: 'run-selection', type: 'scan', startedAt: NOW });
  for (const [index, provider] of ['greenhouse-api', 'browser:indeed'].entries()) {
    registry.recordObservation('run-selection', {
      provider, externalId: `ext-${index}`, sourceUrl: `https://example.com/jobs/${index}`,
      title: index ? 'Senior Data Engineer' : 'Senior AI Systems Engineer', company: `Acme ${index}`,
      location: 'Remote, Worldwide', description: 'Build production AI and data platforms with reliable APIs. '.repeat(5),
      postedAt: '2026-08-23T00:00:00.000Z', retrievedAt: NOW,
    });
  }
  return registry;
}

function policy() {
  return createCandidateSelectionPolicy({
    location: { country: 'Mexico' }, target_roles: { primary: ['AI Systems Engineer'], alternatives: ['Senior Data Engineer'] },
    search_preferences: { work_location: { accepted: ['Remote'], excluded: ['Hybrid', 'On-site'] } },
  }, { max_posting_age_days: 21 }, { minimumSelectionScore: 50 });
}

test('selection persistence, metrics, snapshots, and repeated run are idempotent', () => {
  const registry = setup();
  try {
    const candidates = registry.listCandidateSelectionInputs({ runId: 'run-selection' });
    const engine = new CandidateSelectionEngine({ policy: policy(), clock: () => new Date(NOW) });
    const result = engine.select({ candidates, previousCandidates: registry.listActiveCandidates() });
    registry.recordCandidateSelection('run-selection', result);
    registry.recordCandidateSelection('run-selection', result);
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM candidate_filter_decisions').get().n, 2);
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM active_candidates').get().n, 2);
    assert.equal(registry.db.prepare('SELECT COUNT(*) n FROM active_candidate_transitions').get().n, 2);

    const metrics = {
      RAW_DISCOVERED: 2, NORMALIZED: 2, UNIQUE_JOBS: 2,
      FILTER_PASS: 2, FILTER_REJECT: 0, FILTER_UNKNOWN: 0, ACTIVE_SET: 2,
      ELIGIBILITY_ELIGIBLE: 1, ELIGIBILITY_INELIGIBLE: 0, ELIGIBILITY_UNKNOWN: 1,
      RANKED: 2, TOP_10: 1, DEEP_EVALUATED: 0, PACKAGE_READY: 0,
    };
    registry.recordSemanticFunnelMetrics('run-selection', metrics);
    registry.recordSemanticFunnelMetrics('run-selection', metrics);
    const stored = Object.fromEntries(registry.getSemanticFunnelMetrics('run-selection').map(item => [item.stage, item.count]));
    assert.equal(stored.FILTER_PASS + stored.FILTER_REJECT + stored.FILTER_UNKNOWN, stored.UNIQUE_JOBS);
    assert.equal(stored.ELIGIBILITY_ELIGIBLE + stored.ELIGIBILITY_INELIGIBLE + stored.ELIGIBILITY_UNKNOWN, stored.RANKED);

    const entries = result.activeCandidates.map((item, index) => ({
      runId: 'run-selection', snapshotDate: '2026-08-24', jobId: item.jobId, observationId: item.observationId,
      rank: index + 1, previousRank: null, movement: 'NEW', finalPriorityScore: 90 - index,
      eligibilityStatus: index ? 'UNKNOWN' : 'ELIGIBLE', candidateFitScore: 85,
      opportunityScore: 80, decision: index ? 'REVIEW' : 'SHORTLIST', reasons: ['fixture'],
      confidence: index ? 'low' : 'high', poolOnly: false, evidenceWeak: false,
    }));
    registry.recordDailyPrioritySnapshot('run-selection', { entries, top10: [entries[0]] });
    registry.recordDailyPrioritySnapshot('run-selection', { entries, top10: [entries[0]] });
    assert.equal(registry.getDailyPrioritySnapshot('run-selection').length, 2);
    assert.equal(registry.getDailyPrioritySnapshot('run-selection').filter(item => item.isTop10).length, 1);
  } finally { registry.close(); }
});
