import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { openCandidateKnowledge } from '../candidate-knowledge/provider.mjs';
import { assessActionReadiness } from '../intelligence/action-readiness.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';
import { rankOperationalCandidates, evaluateOperationalCandidates, packageOperationalCandidates } from '../automation/operational-loop.mjs';
import { providerFailureOutcome } from '../runner/provider-policy.mjs';
import { filterV1ScheduledBrowserTasks, V1_BROWSER_CAPABILITIES, supportedV1BrowserCapabilities } from '../research/v1-capabilities.mjs';

const NOW = '2026-08-24T18:00:00.000Z';
const ROOT = new URL('..', import.meta.url).pathname;
const clock = () => new Date(NOW);

function readyInput(overrides = {}) {
  return {
    job: { url: 'https://jobs.example.test/ai-1', description: 'A'.repeat(400), identityConfidence: 'high' },
    observation: { sourceUrl: 'https://jobs.example.test/ai-1', description: 'A'.repeat(400), identityConfidence: 'high' },
    activeCandidate: { state: 'ACTIVE' },
    snapshot: { poolOnly: false, evidenceCompleteness: {
      description: { status: 'PRESENT' }, geography: { status: 'SUPPORTED' }, employment: { status: 'PRESENT' },
      compensation: { status: 'UNKNOWN' }, schedule: { status: 'UNKNOWN' }, companyMarket: { status: 'UNKNOWN' },
      posting: { status: 'REAL_OR_UNSPECIFIED' },
    } },
    assessment: { eligibilityStatus: 'ELIGIBLE', decision: 'SHORTLIST' }, researchNeeds: [],
    evaluation: { status: 'VALID', recommendation: 'APPLY' },
    applicationPackage: { status: 'DRAFT', validationStatus: 'VALID' }, ...overrides,
  };
}

test('ACTION_READY requires critical evidence while compensation alone may remain UNKNOWN', () => {
  const result = assessActionReadiness(readyInput());
  assert.equal(result.state, 'ACTION_READY');
  assert.deepEqual(result.nonCriticalUnknowns.sort(), ['companyMarket', 'compensation', 'schedule']);
  assert.equal(assessActionReadiness(readyInput({ job: { url: 'https://jobs.example.test/ai-1', description: '' }, observation: { sourceUrl: 'https://jobs.example.test/ai-1', description: '', identityConfidence: 'high' } })).state, 'RESEARCH_REQUIRED');
});

test('evidence contradiction and human rejection can never become ACTION_READY', () => {
  const contradictory = readyInput();
  contradictory.snapshot.evidenceCompleteness.geography = { status: 'CONFLICTING' };
  assert.equal(assessActionReadiness(contradictory).state, 'REVIEW_REQUIRED');
  assert.equal(assessActionReadiness(readyInput({ humanDecision: 'REJECT' })).state, 'REVIEW_REQUIRED');
});

test('integrated acceptance traverses selection, eligibility, ranking, evaluation, package, and action readiness', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  try {
    registry.startRun({ id: 'v1-acceptance', startedAt: NOW });
    const description = `Required qualifications:\n- RAG\n- Python\n- Experience building AI systems\n- Flexible hours for a distributed team\n${'Build production retrieval, orchestration, APIs, monitoring, and data pipelines for global customers. '.repeat(5)}`;
    const observed = registry.recordObservation('v1-acceptance', {
      provider: 'fixture', externalId: 'acceptance-ai-1', sourceUrl: 'https://jobs.example.test/acceptance-ai-1',
      canonicalUrl: 'https://jobs.example.test/acceptance-ai-1', title: 'Senior AI Systems Engineer',
      company: 'Acceptance Labs', location: 'Remote, Mexico', description,
      rawMetadata: { employmentType: 'contractor', eligibleCountries: ['Mexico'], remoteScope: 'Mexico' },
      retrievedAt: NOW,
    });
    registry.finishRun('v1-acceptance', { finishedAt: NOW });
    const ranking = await rankOperationalCandidates({ registry, discoveryRunId: 'v1-acceptance', profilePath: `${ROOT}/config/profile.yml`, portalsPath: `${ROOT}/portals.yml`, clock });
    assert.deepEqual(ranking.shortlistedJobIds, [observed.jobId]);
    const candidateProvider = openCandidateKnowledge({ projectRoot: ROOT });
    const evaluations = await evaluateOperationalCandidates({ registry, jobIds: ranking.shortlistedJobIds, candidateProvider, clock });
    assert.equal(evaluations.completed, 1); assert.equal(evaluations.evaluations[0].recommendation, 'APPLY');
    const packages = await packageOperationalCandidates({ registry, evaluations: evaluations.evaluations, candidateProvider, canonicalCv: readFileSync(`${ROOT}/cv.md`, 'utf8'), clock });
    assert.equal(packages.ready, 1);
    const projection = buildControlPlaneProjection(registry.getControlPlaneData({ candidateScope: 'decision' }), { spreadsheetId: 'fixture', schemaVersion: registry.getSchemaVersion(), generatedAt: NOW });
    assert.equal(projection.tabs.TODAY[0]['Attention Status'], 'ACTION_READY');
    assert.equal(registry.getSemanticFunnelMetrics('v1-acceptance').find(item => item.stage === 'TOP_10').count, 1);
  } finally { registry.close(); }
});

test('optional provider unavailability is non-partial while required provider failure remains blocking', () => {
  assert.deepEqual(providerFailureOutcome({ required: false, code: 'slug_gone' }), { required: false, status: 'SUCCESS', code: 'OPTIONAL_UNAVAILABLE', message: '', affectsRunStatus: false });
  assert.equal(providerFailureOutcome({ required: true, code: 'slug_gone' }).affectsRunStatus, true);
  assert.equal(providerFailureOutcome({ required: true, code: 'slug_gone' }).status, 'FAILED');
});

test('V1 capability claims include LinkedIn targeted search but exclude unaccepted discovery surfaces', () => {
  assert.equal(V1_BROWSER_CAPABILITIES.linkedinTargetedSearch, 'SUPPORTED');
  assert.equal(V1_BROWSER_CAPABILITIES.linkedinPersonalizedFeed, 'NOT_INCLUDED_IN_V1');
  assert.equal(V1_BROWSER_CAPABILITIES.indeedDiscovery, 'NOT_INCLUDED_IN_V1');
  assert.equal(V1_BROWSER_CAPABILITIES.occDiscovery, 'NOT_INCLUDED_IN_V1');
  assert.equal(V1_BROWSER_CAPABILITIES.facebookCommunityDiscovery, 'NOT_INCLUDED_IN_V1');
  assert.deepEqual(supportedV1BrowserCapabilities().sort(), ['linkedinTargetedSearch', 'priorityEvidenceEnrichment']);
  assert.deepEqual(filterV1ScheduledBrowserTasks([
    { source: 'linkedin', strategyId: 'linkedin_feed', mode: 'personalized_feed' },
    { source: 'linkedin', strategyId: 'linkedin_search', mode: 'targeted_search' },
    { source: 'indeed', strategyId: 'indeed_search', mode: 'targeted_search' },
    { source: 'occ', strategyId: 'occ_search', mode: 'targeted_search' },
  ]), [{ source: 'linkedin', strategyId: 'linkedin_search', mode: 'targeted_search' }]);
});
