import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { createOpportunityPolicy } from '../intelligence/profile-policy.mjs';
import { evaluateEligibility } from '../intelligence/eligibility-engine.mjs';
import { assessOpportunity } from '../intelligence/funnel.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';
import { ELIGIBILITY_RULES_VERSION } from '../intelligence/contracts.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/opportunity-funnel.json', import.meta.url), 'utf8'));
const policy = createOpportunityPolicy(fixture.profile, fixture.portals);
const NOW = '2026-08-22T12:00:00.000Z';

test('case 1: Remote United States only is INELIGIBLE with explicit location evidence', () => {
  const result = evaluateEligibility(fixture.jobs.usOnly, policy);
  assert.equal(result.status, 'INELIGIBLE');
  assert.ok(result.rulesApplied.includes('location.country_lock'));
  assert.match(result.reasons.join(' '), /excludes a Mexico-based candidate/i);
});

test('case 2: worldwide contractor is ELIGIBLE', () => {
  const result = evaluateEligibility(fixture.jobs.worldwideContractor, policy);
  assert.equal(result.status, 'ELIGIBLE');
  assert.equal(result.signals.employmentModel, 'contract');
  assert.ok(result.rulesApplied.includes('location.inclusive'));
});

test('case 3: bare Remote without country scope is UNKNOWN', () => {
  const result = evaluateEligibility(fixture.jobs.remoteAmbiguous, policy);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.confidence, 'low');
  assert.ok(result.rulesApplied.includes('location.remote_ambiguous'));
});

test('case 4: Director of AI is blocked by canonical seniority policy', () => {
  const result = evaluateEligibility(fixture.jobs.director, policy);
  assert.equal(result.status, 'INELIGIBLE');
  assert.ok(result.rulesApplied.includes('seniority.excluded'));
});

test('case 5: Lead AI Engineer contractor in LATAM has high compatibility', () => {
  const result = assessOpportunity(fixture.jobs.leadLatamContractor, policy, { calculatedAt: NOW });
  assert.equal(result.eligibility.status, 'ELIGIBLE');
  assert.equal(result.candidateFit.band, 'HIGH');
  assert.equal(result.opportunity.band, 'HIGH');
  assert.equal(result.finalPriority.decision, 'SHORTLIST');
  assert.equal(result.compensation.status, 'NOT_COMPARABLE');
});

test('case 6: flexible full-time remains eligible but ranks below preferred contract', () => {
  const fullTime = assessOpportunity(fixture.jobs.flexibleFullTime, policy, { calculatedAt: NOW });
  const contract = assessOpportunity(fixture.jobs.leadLatamContractor, policy, { calculatedAt: NOW });
  assert.equal(fullTime.eligibility.status, 'ELIGIBLE');
  assert.equal(fullTime.opportunity.components.engagement.model, 'full_time');
  assert.ok(fullTime.opportunity.components.engagement.score > 60);
  assert.ok(fullTime.opportunity.score < contract.opportunity.score);
});

test('compensation below a directly comparable configured floor is a hard stop', () => {
  const job = {
    ...fixture.jobs.worldwideContractor,
    rawMetadata: { companyMarket: 'foreign' },
    salary: { min: 20_000, max: 30_000, currency: 'MXN', period: 'month', basis: 'net' },
  };
  const result = assessOpportunity(job, policy, { calculatedAt: NOW });
  assert.equal(result.eligibility.status, 'INELIGIBLE');
  assert.equal(result.compensation.comparison, 'below_threshold');
  assert.equal(result.finalPriority.decision, 'REJECT');
});

test('case 8: every result is explainable and dimensions remain separate', () => {
  const result = assessOpportunity(fixture.jobs.leadLatamContractor, policy, { calculatedAt: NOW });
  assert.ok(result.eligibility.reasons.length >= 3);
  assert.ok(result.eligibility.evidence.every(item => item.ruleId && item.field && item.source));
  assert.ok(result.candidateFit.reasons.length > 0);
  assert.ok(result.opportunity.reasons.length > 0);
  assert.match(result.finalPriority.reasons.at(-1), /Decision: SHORTLIST/);
  assert.notEqual(result.eligibility.eligibilityScore, result.candidateFit.score);
});

test('assessment output is deterministic when calculation time is injected', () => {
  const first = assessOpportunity(fixture.jobs.leadLatamContractor, policy, { calculatedAt: NOW });
  const second = assessOpportunity(structuredClone(fixture.jobs.leadLatamContractor), policy, { calculatedAt: NOW });
  assert.deepEqual(first, second);
});

test('configured Browser Discovery penalties reduce final priority with an explicit reason', () => {
  const baseline = assessOpportunity(fixture.jobs.worldwideContractor, policy, { calculatedAt: NOW });
  const penalized = assessOpportunity({
    ...fixture.jobs.worldwideContractor,
    rawMetadata: { discoveryStrategy: { strategyId: 'linkedin_search', priorityAdjustment: -25 } },
  }, policy, { calculatedAt: NOW });
  assert.equal(penalized.finalPriority.score, Math.max(0, baseline.finalPriority.score - 25));
  assert.match(penalized.finalPriority.reasons.join(' '), /Discovery strategy adjustment: -25 points/);
});

test('case 7: reassessment under a new rule version preserves history', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  try {
    registry.startRun({ id: 'assessment-run', startedAt: NOW });
    const observed = registry.recordObservation('assessment-run', {
      provider: 'fixture', externalId: 'lead-1', sourceUrl: 'https://jobs.example.test/lead-1',
      ...fixture.jobs.leadLatamContractor, retrievedAt: NOW,
    });
    registry.finishRun('assessment-run', { finishedAt: NOW });
    const input = { ...fixture.jobs.leadLatamContractor, observationId: observed.observationId };
    const v1 = assessOpportunity(input, policy, { calculatedAt: NOW, eligibilityRulesVersion: '1' });
    const first = registry.recordAssessment(observed.jobId, observed.observationId, v1);
    const duplicate = registry.recordAssessment(observed.jobId, observed.observationId, v1);
    const v2 = assessOpportunity(input, policy, { calculatedAt: NOW, eligibilityRulesVersion: '2' });
    const second = registry.recordAssessment(observed.jobId, observed.observationId, v2);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.existing, true);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(registry.getAssessments(observed.jobId).map(item => item.eligibilityRulesVersion), ['1', '2']);
  } finally { registry.close(); }
});

test('assessment candidates include unassessed run observations and skip current-version repeats', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  try {
    registry.startRun({ id: 'candidate-run', startedAt: NOW });
    const observed = registry.recordObservation('candidate-run', {
      provider: 'fixture', externalId: 'candidate-1', sourceUrl: 'https://jobs.example.test/candidate-1',
      ...fixture.jobs.worldwideContractor, retrievedAt: NOW,
      rawMetadata: { salary: { min: 50, max: 75, currency: 'USD', period: 'hour' } },
    });
    registry.finishRun('candidate-run', { finishedAt: NOW });
    const query = { eligibilityRulesVersion: ELIGIBILITY_RULES_VERSION, rankingRulesVersion: '4', profileHash: policy.profileHash, runId: 'candidate-run' };
    const candidates = registry.listAssessmentCandidates(query);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].salary.min, 50);
    const assessment = assessOpportunity(candidates[0], policy, { calculatedAt: NOW });
    registry.recordAssessment(observed.jobId, observed.observationId, assessment);
    assert.equal(registry.listAssessmentCandidates(query).length, 0);
    assert.equal(registry.listAssessmentCandidates({ ...query, rankingRulesVersion: '5' }).length, 1);
  } finally { registry.close(); }
});

test('intelligence engines have no persistence or LLM dependency', () => {
  for (const file of ['eligibility-engine.mjs', 'ranking-engine.mjs', 'funnel.mjs']) {
    const source = readFileSync(new URL(`../intelligence/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /better-sqlite3|openai|anthropic|gemini|JobRegistry|\.db\b/);
  }
});
