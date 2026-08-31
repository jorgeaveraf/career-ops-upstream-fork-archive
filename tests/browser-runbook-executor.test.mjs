import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRunbookExecutor } from '../research/browser-runbook-executor.mjs';
import { browserRunbookForTask } from '../research/source-runbooks.mjs';
import { PriorityResearchPlanner } from '../research/priority-research-planner.mjs';
import { evidenceResolvesNeed, extractCandidateEvidence, validateCandidateIdentity } from '../research/enrichment-evidence.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';
import { createOpportunityPolicy } from '../intelligence/profile-policy.mjs';
import { assessOpportunity } from '../intelligence/funnel.mjs';
import { partitionResearchEvidence, reassessResolvedCandidates } from '../research/enrichment-runner.mjs';

const START = Date.parse('2026-08-24T20:00:00.000Z');
const record = (id, extra = {}) => ({ externalId: id, url: `https://www.linkedin.com/jobs/view/${id}`, title: `AI Engineer ${id}`, company: 'Acme', ...extra });

function harness(snapshots, overrides = {}) {
  let now = START; let index = 0; let scrolls = 0; let closed = 0; let details = 0;
  const clock = () => new Date(now); const sleep = async ms => { now += ms; };
  const driver = {
    async open() { return 'tab'; },
    async snapshot() { const value = typeof snapshots === 'function' ? snapshots({ index, scrolls }) : snapshots[Math.min(index++, snapshots.length - 1)]; return structuredClone(value); },
    async scroll() { scrolls++; now += 10; }, async close() { closed++; },
    async extractDetails(_handle, value) { details++; return { fullDescription: `${value.title} ${'production systems '.repeat(20)}`, detailUrl: value.url }; },
    ...overrides,
  };
  return { executor: new BrowserRunbookExecutor({ clock, sleep }), driver, stats: () => ({ scrolls, closed, details, now }) };
}

const linkedInTask = { id: 'linkedin-search', source: 'linkedin', mode: 'targeted_search', query: 'AI Engineer', url: 'https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer' };
const baseSnapshot = { url: linkedInTask.url, title: 'AI Engineer jobs | LinkedIn', text: 'AI Engineer', domReady: true, cardCount: 0, selectorMatchCount: 0, records: [], queryConfirmed: true };

test('delayed LinkedIn cards transition through semantic waiting and then succeed', async () => {
  const h = harness([baseSnapshot, { ...baseSnapshot, cardCount: 1, selectorMatchCount: 1, records: [record('1')] }]);
  const runbook = browserRunbookForTask(linkedInTask, { pollMs: 5, readinessMs: 50, maxScrollPasses: 0, maxDetails: 0 });
  const result = await h.executor.execute({ task: linkedInTask, runbook, driver: h.driver });
  assert.equal(result.outcome, 'SUCCESS_RESULTS'); assert.equal(result.records.length, 1);
  assert.deepEqual(result.telemetry.states.slice(0, 5).map(item => item.state), ['PLANNED', 'NAVIGATING', 'PAGE_CLASSIFIED', 'RESULTS_WAITING', 'PAGE_CLASSIFIED']);
  assert.ok(result.telemetry.timeToFirstResultsMs >= 5); assert.equal(h.stats().closed, 1);
});

test('bounded scrolling collects new cards, deduplicates by external identity, and stops after stable passes', async () => {
  const snapshots = ({ scrolls }) => ({ ...baseSnapshot, cardCount: scrolls < 1 ? 1 : scrolls < 2 ? 2 : 3,
    selectorMatchCount: 1, records: scrolls < 1 ? [record('1')] : scrolls < 2 ? [record('1'), record('2')] : [record('1'), record('2'), record('2')], resultFingerprint: scrolls < 1 ? '1' : '1|2' });
  const h = harness(snapshots); const runbook = browserRunbookForTask(linkedInTask, { maxScrollPasses: 6, stablePasses: 2, maxDetails: 0 });
  const result = await h.executor.execute({ task: linkedInTask, runbook, driver: h.driver });
  assert.equal(result.records.length, 2); assert.equal(h.stats().scrolls, 3); assert.equal(result.telemetry.duplicates, 1);
  assert.deepEqual(result.telemetry.scrollPasses.map(item => item.uniqueAdded), [1, 0, 0]);
});

test('LinkedIn feed performs a real scroll pass even when its initial card budget is full', async () => {
  const feedTask = { ...linkedInTask, id: 'feed', mode: 'personalized_feed', query: '', url: 'https://www.linkedin.com/jobs/collections/recommended/' };
  const h = harness([{ ...baseSnapshot, url: feedTask.url, cardCount: 1, selectorMatchCount: 1, records: [record('1')] }]);
  const result = await h.executor.execute({ task: feedTask, runbook: browserRunbookForTask(feedTask, { maxCards: 1, maxDetails: 0 }), driver: h.driver });
  assert.equal(result.outcome, 'SUCCESS_RESULTS'); assert.equal(h.stats().scrolls, 1); assert.equal(result.telemetry.scrollPasses.length, 1);
});

test('login, challenge, selector drift, and unconfirmed query are distinct terminal outcomes', async () => {
  for (const [snapshot, expected] of [
    [{ ...baseSnapshot, url: 'https://www.linkedin.com/login', title: 'Sign in', text: 'Sign in to LinkedIn' }, 'AUTH_REQUIRED'],
    [{ ...baseSnapshot, url: 'https://www.linkedin.com/checkpoint/challenge', text: 'Security verification' }, 'CHALLENGE'],
  ]) {
    const h = harness([snapshot]); const result = await h.executor.execute({ task: linkedInTask, runbook: browserRunbookForTask(linkedInTask), driver: h.driver }); assert.equal(result.outcome, expected);
  }
  const drift = harness([baseSnapshot]); const driftResult = await drift.executor.execute({ task: linkedInTask, runbook: browserRunbookForTask(linkedInTask, { readinessMs: 10, pollMs: 5 }), driver: drift.driver });
  assert.equal(driftResult.outcome, 'SELECTOR_CHANGED');
  const wrong = harness([{ ...baseSnapshot, cardCount: 1, selectorMatchCount: 1, records: [record('1')], queryConfirmed: false }]);
  const wrongResult = await wrong.executor.execute({ task: linkedInTask, runbook: browserRunbookForTask(linkedInTask, { maxScrollPasses: 0 }), driver: wrong.driver });
  assert.equal(wrongResult.outcome, 'WRONG_PAGE'); assert.ok(wrongResult.telemetry.warnings.includes('QUERY_NOT_CONFIRMED'));
});

test('detail acquisition is bounded and task budget exhaustion is visible', async () => {
  const h = harness([{ ...baseSnapshot, cardCount: 2, selectorMatchCount: 2, records: [record('1'), record('2')] }]);
  const result = await h.executor.execute({ task: linkedInTask, runbook: browserRunbookForTask(linkedInTask, { maxScrollPasses: 0, maxDetails: 1 }), driver: h.driver });
  assert.equal(h.stats().details, 1); assert.match(result.records[0].fullDescription, /production systems/);
  const budget = harness([baseSnapshot]); const exhausted = await budget.executor.execute({ task: linkedInTask, runbook: browserRunbookForTask(linkedInTask, { readinessMs: 100, pollMs: 5, maxTaskMs: 5 }), driver: budget.driver });
  assert.ok(exhausted.telemetry.warnings.includes('TASK_BUDGET_EXHAUSTED')); assert.equal(budget.stats().closed, 1);
});

test('policy failures become POLICY_BLOCKED and still run cleanup when a handle exists', async () => {
  const error = new Error('denied'); error.code = 'BROWSER_ACTION_DENIED';
  const h = harness([baseSnapshot], { async open() { throw error; } });
  const result = await h.executor.execute({ task: linkedInTask, runbook: browserRunbookForTask(linkedInTask), driver: h.driver });
  assert.equal(result.outcome, 'POLICY_BLOCKED'); assert.equal(result.telemetry.errors[0].code, 'BROWSER_ACTION_DENIED');
});

test('PriorityResearchPlanner puts TOP and high-priority evidence needs first', () => {
  const needs = [
    { id: 'low', jobId: 'a', status: 'OPEN', type: 'CONFIRM_COMPENSATION', priority: 'LOW', priorityScore: 10 },
    { id: 'top', jobId: 'b', status: 'OPEN', type: 'FETCH_FULL_DESCRIPTION', priority: 'HIGH', priorityScore: 90 },
  ];
  const candidates = [{ jobId: 'a', observationId: 'oa', sourceUrl: 'https://example.test/a', title: 'A', company: 'A' }, { jobId: 'b', observationId: 'ob', sourceUrl: 'https://example.test/b', title: 'B', company: 'B' }];
  const tasks = new PriorityResearchPlanner({ maxTasks: 2 }).plan({ needs, candidates, snapshot: [{ jobId: 'b', isTop10: true, rank: 1, finalPriorityScore: 80 }] });
  assert.equal(tasks[0].jobId, 'b'); assert.equal(tasks[0].needs[0].type, 'FETCH_FULL_DESCRIPTION');
  assert.equal(tasks.some(item=>item.jobId==='a'),false);
});

test('candidate identity mismatch is rejected and extracted evidence resolves only supported needs', () => {
  const candidate = { title: 'AI Engineer', company: 'Acme', canonicalUrl: 'https://example.test/jobs/1' };
  assert.equal(validateCandidateIdentity(candidate, { title: 'Sales Manager', company: 'Other', url: 'https://example.test/jobs/2' }).code, 'EVIDENCE_IDENTITY_UNCERTAIN');
  const evidence = extractCandidateEvidence({ url: candidate.canonicalUrl, fullDescription: `Remote from Mexico. Full-time. USD 100000 per year. ${'Build AI systems. '.repeat(20)}` }, { source: 'primary', retrievedAt: new Date(START).toISOString() });
  assert.equal(evidenceResolvesNeed({ type: 'FETCH_FULL_DESCRIPTION' }, evidence), true);
  assert.equal(evidenceResolvesNeed({ type: 'CONFIRM_MEXICO_ELIGIBILITY' }, evidence), true);
  assert.ok(evidence.every(item => item.sourceUrl && item.retrievedAt && item.resolverVersion));
});

test('a successfully inspected canonical source explicitly blocks fields it does not evidence', () => {
  const needs=[{id:'geo',type:'CONFIRM_MEXICO_ELIGIBILITY'},{id:'comp',type:'CONFIRM_COMPENSATION'}];
  const result=partitionResearchEvidence(needs,[{field:'eligibleCountries',value:['Mexico']}]);
  assert.deepEqual(result.resolved.map(item=>item.id),['geo']);
  assert.deepEqual(result.unsupported.map(item=>item.id),['comp']);
});

test('semantic task telemetry and per-pass observations persist separately from provider ROI', () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(START) });
  try {
    registry.startRun({ id: 'semantic', type: 'browser-discovery', startedAt: new Date(START).toISOString() });
    registry.recordBrowserTaskTelemetry('semantic', { taskId: 't', source: 'linkedin', strategyId: 'feed', plannedUrl: linkedInTask.url,
      finalUrl: linkedInTask.url, title: 'Jobs', pageClassification: 'EXPECTED_RESULTS', authObserved: false,
      expectedSelector: '.card', selectorsVersion: 'v1', timeToFirstResultsMs: 10,
      scrollPasses: [{ pass: 1, cardsBefore: 1, cardsAfter: 2, uniqueAdded: 1, fingerprint: '1|2', at: new Date(START).toISOString() }],
      cardsSeen: 2, uniqueCards: 2, extractedRecords: 2, detailPagesOpened: 1, duplicates: 0,
      outcome: 'SUCCESS_RESULTS', phaseDurationsMs: { navigation: 5 }, states: [], warnings: [], errors: [],
      startedAt: new Date(START).toISOString(), finishedAt: new Date(START + 20).toISOString(), durationMs: 20 }, { mode: 'DISCOVERY' });
    const report = registry.getBrowserObservabilityReport({ runId: 'semantic' });
    assert.equal(report.semanticSuccessRate, 1); assert.equal(report.cardsSeen, 2); assert.equal(report.detailsOpened, 1);
    assert.equal(registry.db.prepare('SELECT COUNT(*) count FROM browser_scroll_pass_telemetry').get().count, 1);
  } finally { registry.close(); }
});

test('resolved geography evidence reassesses only the targeted candidate and rebuilds priority snapshot', () => {
  const clock = () => new Date(START); const registry = new JobRegistry({ dbPath: ':memory:', clock });
  const policy = createOpportunityPolicy({ location: { country: 'Mexico', authorized_in: ['Mexico'], international_contracting: { accepted: true } },
    target_roles: { primary: ['AI Engineer'], seniority: { preferred: ['Senior'], excluded: [] } },
    search_preferences: { work_location: { accepted: ['Remote'], excluded: [] }, employment_types: [{ type: 'Full-time', preference: 1 }] } }, {});
  try {
    registry.startRun({ id: 'targeted', type: 'browser-enrichment', startedAt: new Date(START).toISOString() });
    const observed = ['one', 'two'].map(id => registry.recordObservation('targeted', { provider: 'fixture', externalId: id,
      sourceUrl: `https://example.test/${id}`, canonicalUrl: `https://example.test/${id}`, title: 'Senior AI Engineer', company: `Acme ${id}`,
      location: 'Remote', description: 'Build production AI systems.', retrievedAt: new Date(START).toISOString() }));
    for (const item of observed) {
      const candidate = registry.listCandidateSelectionInputs({ jobId: item.jobId })[0];
      const assessment = registry.recordAssessment(item.jobId, item.observationId, assessOpportunity(candidate, policy, { calculatedAt: new Date(START).toISOString() }));
      registry.syncCandidateResearchNeeds({ selectionRunId: 'targeted', assessmentId: assessment.id, jobId: item.jobId, observationId: item.observationId,
        needs: assessment.result.eligibility.researchNeeds, versions: { unifiedPolicyVersion: '1', eligibilityRulesVersion: assessment.eligibilityRulesVersion, completenessVersion: '1', researchNeedsVersion: '1' }, policyHash: policy.policyHash });
    }
    registry.recordCandidateSelection('targeted', { rulesVersion: '1', policyHash: policy.policyHash, capacity: 2, threshold: 0, fillToCapacity: false, decisions: [], transitions: [], counts: { raw: 2, PASS: 2, REJECT: 0, UNKNOWN: 0, active: 2 },
      activeCandidates: observed.map((item, index) => ({ jobId: item.jobId, observationId: item.observationId, state: 'ACTIVE', stateReason: 'fixture', preliminaryScore: 80 - index, freshnessDays: 0, source: 'fixture', selectionRank: index + 1 })) });
    const need = registry.listCandidateResearchNeeds({ jobId: observed[0].jobId }).find(item => item.type === 'CONFIRM_MEXICO_ELIGIBILITY');
    registry.resolveCandidateResearchNeed(need.id, { evidence: [{ field: 'eligibleCountries', value: ['Mexico'], sourceUrl: 'https://example.test/one' }], resolvedAt: new Date(START).toISOString() });
    registry.recordObservation('targeted', { provider: 'browser:enrichment', sourceUrl: 'https://example.test/one', canonicalUrl: 'https://example.test/one',
      title: 'Senior AI Engineer', company: 'Acme one', location: 'Remote', description: 'Remote from Mexico. Build production AI systems for global customers.',
      retrievedAt: new Date(START + 1).toISOString(), evidence: [{ field: 'eligibleCountries', value: ['Mexico'], confidence: 'high', extractionMethod: 'parsed' }], extractionMethod: 'parsed' });
    const beforeSecond = registry.getAssessments(observed[1].jobId).length;
    const result = reassessResolvedCandidates({ registry, runId: 'targeted', jobIds: [observed[0].jobId], policy,
      selectionPolicy: { topMinimumPriorityScore: 0, topLimit: 10 }, clock: () => new Date(START + 2) });
    assert.equal(result.reassessed, 1); assert.equal(registry.getAssessments(observed[1].jobId).length, beforeSecond);
    assert.ok(registry.getDailyPrioritySnapshot('targeted').length >= 1); assert.equal(registry.listCandidateReassessmentQueue({ status: 'PENDING' }).length, 0);
  } finally { registry.close(); }
});
