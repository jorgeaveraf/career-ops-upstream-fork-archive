import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpportunityPolicy } from '../intelligence/profile-policy.mjs';
import { evaluateEligibility } from '../intelligence/eligibility-engine.mjs';
import { assessOpportunity } from '../intelligence/funnel.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const NOW = '2026-08-24T18:00:00.000Z';
const profile = {
  location: { country: 'Mexico', authorized_in: ['Mexico'], international_contracting: { accepted: true } },
  target_roles: { primary: ['AI Systems Engineer'], seniority: { preferred: ['Senior'], excluded: ['Director'] } },
  search_preferences: {
    work_location: { accepted: ['Remote'], excluded: ['Hybrid', 'On-site'] },
    employment_types: [{ type: 'Contract', preference: 1 }, { type: 'Full-time', preference: 5 }],
  },
  discovery_strategy: { rejection_rules: { companies: ['lemon'] } },
};
const policy = createOpportunityPolicy(profile, {});
const job = overrides => ({ title: 'Senior AI Systems Engineer', company: 'Acme', location: 'México',
  description: 'Build production AI systems.', sourceUrl: 'https://example.test/job', ...overrides });

test('Mexico and México normalize to equivalent positive geography', () => {
  const plain = evaluateEligibility(job({ location: 'Mexico' }), policy);
  const accented = evaluateEligibility(job({ location: 'México' }), policy);
  assert.equal(plain.status, 'ELIGIBLE');
  assert.equal(accented.status, 'ELIGIBLE');
  assert.equal(plain.signals.geography.status, accented.signals.geography.status);
});

test('title scope Remote - ONLY MEXICO is high-confidence evidence', () => {
  const result = evaluateEligibility(job({ title: 'AI Engineer - Remote - ONLY MEXICO', location: 'Remote' }), policy);
  assert.equal(result.status, 'ELIGIBLE');
  assert.ok(result.evidence.some(item => item.field === 'title' && item.confidence === 'high'));
});

test('typed field evidence is consumed while provider identity does not change policy outcome', () => {
  const evidence = provider => [{ field: 'eligibleCountries', value: ['Mexico'], confidence: 'high', provider }];
  const core = evaluateEligibility(job({ location: 'Remote', provider: 'greenhouse', fieldEvidence: evidence('greenhouse') }), policy);
  const browser = evaluateEligibility(job({ location: 'Remote', provider: 'browser:indeed', fieldEvidence: evidence('browser:indeed') }), policy);
  assert.equal(core.status, 'ELIGIBLE');
  assert.equal(browser.status, 'ELIGIBLE');
  assert.ok(core.evidence.some(item => item.field === 'fieldEvidence.eligibleCountries'));
});

test('Remote alone remains UNKNOWN with typed geography needs', () => {
  const result = evaluateEligibility(job({ location: 'Remote' }), policy);
  assert.equal(result.status, 'UNKNOWN');
  assert.ok(result.researchNeeds.some(item => item.type === 'CONFIRM_MEXICO_ELIGIBILITY'));
  assert.ok(result.researchNeeds.some(item => item.type === 'CONFIRM_REMOTE_SCOPE'));
  assert.ok(result.explainability.unknown.some(item => item.dimension === 'geography'));
});

test('Worldwide is positive but worldwide plus US residency is a conflict', () => {
  assert.equal(evaluateEligibility(job({ location: 'Worldwide' }), policy).status, 'ELIGIBLE');
  const conflict = evaluateEligibility(job({ location: 'Worldwide', description: 'Must reside in United States.' }), policy);
  assert.equal(conflict.status, 'UNKNOWN');
  assert.equal(conflict.signals.geography.status, 'CONFLICTING');
  assert.ok(conflict.researchNeeds.some(item => item.type === 'RESOLVE_LOCATION_CONFLICT'));
});

test('missing compensation does not degrade evidenced geographic eligibility', () => {
  const result = evaluateEligibility(job({ salary: null }), policy);
  assert.equal(result.status, 'ELIGIBLE');
  assert.equal(result.signals.compensation.status, 'UNKNOWN');
  assert.ok(result.researchNeeds.some(item => item.type === 'CONFIRM_COMPENSATION'));
});

test('directly comparable salary below market threshold is ineligible', () => {
  const result = evaluateEligibility(job({ rawMetadata: { companyMarket: 'foreign' },
    salary: { amount: 30_000, currency: 'MXN', period: 'month', basis: 'net' } }), policy);
  assert.equal(result.signals.compensation.status, 'BELOW_THRESHOLD');
  assert.equal(result.status, 'INELIGIBLE');
});

test('Micro1 and BairesDev are hard rejects independent of provider', () => {
  for (const [company, provider] of [['Micro1', 'greenhouse'], ['BairesDev', 'browser:indeed']]) {
    const result = evaluateEligibility(job({ company, provider }), policy);
    assert.equal(result.status, 'INELIGIBLE');
    assert.ok(result.rulesApplied.includes('company.hard_reject'));
  }
});

test('Lemon.io variants are hard rejected independently of provider without a Lemonade false positive', () => {
  for (const [company, provider] of [['Lemon.io', 'greenhouse'], ['lemon.io', 'browser:linkedin'], ['Lemon', 'lever']]) {
    const result = evaluateEligibility(job({ company, provider }), policy);
    assert.equal(result.status, 'INELIGIBLE');
    assert.ok(result.rulesApplied.includes('company.hard_reject'));
  }
  assert.notEqual(evaluateEligibility(job({ company: 'Lemonade', provider: 'lever' }), policy).status, 'INELIGIBLE');
});

test('confirmed pool rejects while a concrete marketplace role only warns', () => {
  const pool = evaluateEligibility(job({ title: 'Join our talent pool', description: 'Future opportunities.' }), policy);
  assert.equal(pool.status, 'INELIGIBLE');
  assert.ok(pool.rulesApplied.includes('posting.pool_only'));
  const real = evaluateEligibility(job({ title: 'Senior AI Systems Engineer', description: 'Concrete client project. We match you with clients.' }), policy);
  assert.equal(real.status, 'ELIGIBLE');
  assert.ok(real.rulesApplied.includes('posting.marketplace_warning'));
  assert.ok(real.researchNeeds.some(item => item.type === 'CONFIRM_POSTING_IS_REAL'));
});

test('missing description creates a deterministic high-priority fetch need', () => {
  const input = job({ description: 'UNKNOWN', selectionScore: 90, selectionRank: 1 });
  const first = evaluateEligibility(input, policy);
  const second = evaluateEligibility(structuredClone(input), policy);
  const need = first.researchNeeds.find(item => item.type === 'FETCH_FULL_DESCRIPTION');
  assert.equal(need.priority, 'HIGH');
  assert.deepEqual(first, second);
});

test('resolving a persisted need queues only that candidate for reassessment', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  try {
    registry.startRun({ id: 'repair-run', type: 'eligibility-repair', startedAt: NOW });
    const observed = registry.recordObservation('repair-run', { provider: 'fixture', externalId: 'one',
      sourceUrl: 'https://example.test/one', retrievedAt: NOW, ...job({ location: 'Remote', description: 'UNKNOWN' }) });
    const candidate = { ...job({ location: 'Remote', description: 'UNKNOWN' }), jobId: observed.jobId, observationId: observed.observationId };
    const assessment = registry.recordAssessment(observed.jobId, observed.observationId, assessOpportunity(candidate, policy, { calculatedAt: NOW }));
    registry.syncCandidateResearchNeeds({ selectionRunId: 'repair-run', assessmentId: assessment.id,
      jobId: observed.jobId, observationId: observed.observationId, needs: assessment.result.eligibility.researchNeeds,
      versions: { unifiedPolicyVersion: '1', eligibilityRulesVersion: '2', completenessVersion: '1', researchNeedsVersion: '1' }, policyHash: policy.policyHash });
    const need = registry.listCandidateResearchNeeds({ jobId: observed.jobId }).find(item => item.type === 'CONFIRM_MEXICO_ELIGIBILITY');
    registry.resolveCandidateResearchNeed(need.id, { evidence: [{ sourceUrl: 'https://example.test/one', signal: 'Mexico eligible' }], resolvedAt: NOW });
    const queue = registry.listCandidateReassessmentQueue({ status: 'PENDING' });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].jobId, observed.jobId);
    assert.equal(registry.listCandidateResearchNeeds({ status: 'RESOLVED' }).length, 1);
  } finally { registry.close(); }
});
