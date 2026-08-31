import test from 'node:test';
import assert from 'node:assert/strict';
import { openCandidateKnowledge } from '../candidate-knowledge/provider.mjs';
import { createDiscoveryStrategy } from '../discovery-strategy/engine.mjs';
import { generateDiscoveryStrategyTasks } from '../discovery-strategy/tasks.mjs';
import { detectPoolSignals, evaluateCompensation, evaluateDiscoveryCandidate } from '../discovery-strategy/rules.mjs';
import { scoreFacebookAuthenticity } from '../discovery-strategy/facebook-authenticity.mjs';
import { buildBrowserDiscoveryTasks } from '../research/discovery-tasks.mjs';
import { browserDiscoverySourceAdapters } from '../research/discovery-source-adapters.mjs';
import { runBrowserDiscovery } from '../research/discovery-runner.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const NOW = '2026-08-23T22:00:00.000Z'; const clock = () => new Date(NOW);
const provider = openCandidateKnowledge({ projectRoot: new URL('..', import.meta.url).pathname });
const strategy = createDiscoveryStrategy({ candidateProvider: provider });

test('strategy loads roles, preferences, and technologies through Candidate Knowledge Provider', () => {
  assert.equal(strategy.candidateKbRevision, provider.getMetadata().revision);
  assert.deepEqual(strategy.roles.primary, provider.getPreferences().primary_roles);
  assert.ok(strategy.roles.secondary.includes('AI Platform Engineer'));
  assert.ok(strategy.technologies.includes('Python')); assert.ok(strategy.technologies.includes('LangGraph'));
  assert.equal(strategy.preferences.remoteOnly, true); assert.equal(strategy.preferences.contractorPreferred, true);
  assert.ok(strategy.sourcePriorities.discovery_volume.includes('indeed_search'));
  assert.ok(strategy.sourcePriorities.hidden_opportunity_signals.includes('facebook_group'));
  assert.match(strategy.revision, /^1:[a-f0-9]{12}$/);
});

test('global company rules hard-reject Micro1, BairesDev, and Lemon.io variants', () => {
  for (const company of ['Micro1', 'BairesDev', 'Lemon.io', 'lemon.io', 'Lemon']) {
    const result = evaluateDiscoveryCandidate({ company, description: 'Remote AI role' }, strategy);
    assert.equal(result.hardReject, true);
  }
  assert.equal(evaluateDiscoveryCandidate({ company: 'Lemonade', description: 'Remote AI role' }, strategy).hardReject, false);
});

test('talent-pool language distinguishes pool-only from a concrete marketplace role', () => {
  const result = detectPoolSignals('Join our talent network; we match you with clients.', strategy.rejectionRules.pool_signals);
  assert.equal(result.detected, true); assert.deepEqual(result.matched, ['join our talent network', 'we match you with clients']);
  const poolOnly = evaluateDiscoveryCandidate({ company: 'Example', description: 'Developer pool with multiple opportunities available' }, strategy);
  assert.equal(poolOnly.accepted, false); assert.equal(poolOnly.hardReject, true);
  const concrete = evaluateDiscoveryCandidate({ title: 'Senior AI Engineer', company: 'Example', description: 'A concrete client project; we match you with clients.' }, strategy);
  assert.equal(concrete.accepted, true); assert.equal(concrete.priorityAdjustment, -25);
});

test('compensation policy distinguishes foreign, Mexico, unknown, and exceptional below-threshold cases', () => {
  const comparable = amount => ({ amount, currency: 'MXN', period: 'month', basis: 'net' });
  assert.equal(evaluateCompensation({ salary: comparable(45000), companyMarket: 'foreign' }, strategy.compensationPolicy).state, 'KNOWN');
  const foreignLow = evaluateCompensation({ salary: comparable(39000), companyMarket: 'foreign' }, strategy.compensationPolicy);
  assert.equal(foreignLow.state, 'BELOW_THRESHOLD'); assert.equal(foreignLow.hardReject, true);
  assert.equal(evaluateCompensation({ salary: comparable(49000), companyMarket: 'mexico' }, strategy.compensationPolicy).state, 'BELOW_THRESHOLD');
  assert.equal(evaluateCompensation({ companyMarket: 'foreign' }, strategy.compensationPolicy).state, 'UNKNOWN');
  const exceptional = evaluateCompensation({ salary: comparable(30000), companyMarket: 'foreign', exceptional: true }, strategy.compensationPolicy);
  assert.equal(exceptional.state, 'BELOW_THRESHOLD'); assert.equal(exceptional.hardReject, false);
});

test('LinkedIn runbook keeps personalized feed before targeted searches', () => {
  const tasks = generateDiscoveryStrategyTasks(strategy).filter(task => task.source === 'linkedin');
  assert.equal(tasks[0].strategyId, 'linkedin_feed'); assert.equal(tasks[0].mode, 'personalized_feed');
  assert.equal(tasks[0].priorityDimension, 'hidden_opportunity_signals');
  assert.ok(tasks.slice(1).every(task => task.strategyId === 'linkedin_search' && task.mode === 'targeted_search'));
  assert.ok(tasks.some(task => task.query === 'AI Systems Engineer'));
  assert.ok(tasks.some(task => task.query === 'Airflow'));
});

test('Indeed, OCC, and Facebook remain separate platform runbooks', () => {
  const tasks = generateDiscoveryStrategyTasks(strategy);
  assert.ok(tasks.some(task => task.strategyId === 'indeed_search' && task.query === 'LLM Engineer remote'));
  assert.ok(tasks.some(task => task.strategyId === 'occ_search' && task.query === 'Ingeniero IA'));
  assert.ok(tasks.some(task => task.strategyId === 'facebook_group' && task.query === 'Remote Jobs LATAM' && task.execution === 'planned_only'));
});

test('Facebook application evidence increases authenticity while marketplace signals reduce it', () => {
  const high = scoreFacebookAuthenticity({ applicationEmail: true, companyIdentified: true, descriptionQuality: 'high', stackDefined: true, responsibilitiesClear: true, salaryVisible: true });
  const low = scoreFacebookAuthenticity({ companyIdentified: true, descriptionQuality: 'medium', poolLanguage: true, registerHere: true, marketplace: true });
  assert.equal(high.score, 100); assert.equal(high.band, 'HIGH'); assert.ok(low.score < high.score); assert.equal(low.band, 'LOW');
});

test('every generated task explains why it exists and generation is deterministic', () => {
  const first = generateDiscoveryStrategyTasks(strategy); const second = generateDiscoveryStrategyTasks(strategy);
  assert.deepEqual(first, second); assert.ok(first.length > 0);
  for (const task of first) {
    assert.ok(task.explanation.reason); assert.equal(task.explanation.strategyRevision, strategy.revision);
    assert.ok(task.objective); assert.ok(task.strategyId);
  }
});

test('Browser Discovery consumes executable strategy tasks and leaves Facebook planned-only', () => {
  const planned = generateDiscoveryStrategyTasks(strategy);
  const executable = buildBrowserDiscoveryTasks({
    config: { browser_discovery: { enabled: true, maxResultsPerTask: 5 } },
    adapters: browserDiscoverySourceAdapters(), strategyTasks: planned,
  });
  assert.ok(executable.some(task => task.strategyId === 'linkedin_feed' && task.url.includes('/jobs/collections/recommended/')));
  assert.ok(executable.some(task => task.source === 'indeed')); assert.ok(executable.some(task => task.source === 'occ'));
  assert.equal(executable.some(task => task.source === 'facebook'), false);
  assert.ok(executable.every(task => task.maxResults === 5));
  const linkedInOnly = buildBrowserDiscoveryTasks({
    config: { browser_discovery: { enabled: true, sources: { linkedin: { enabled: true } } } },
    adapters: browserDiscoverySourceAdapters(), strategyTasks: planned,
  });
  assert.ok(linkedInOnly.length > 0); assert.ok(linkedInOnly.every(task => task.source === 'linkedin'));
});

test('strategy hard rejects stay outside Registry and strategy metrics retain task outcome', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  const adapters = browserDiscoverySourceAdapters();
  const task = buildBrowserDiscoveryTasks({
    config: { browser_discovery: { enabled: true } }, adapters,
    strategyTasks: generateDiscoveryStrategyTasks(strategy).filter(item => item.strategyId === 'linkedin_feed'),
  })[0];
  const browserAdapter = { async start() {}, async close() {}, async discover() { return { retrievedAt: NOW, records: [{
    url: 'https://www.linkedin.com/jobs/view/999', title: 'AI Systems Engineer', company: 'BairesDev', location: 'Remote', description: 'Remote AI systems role',
  }] }; } };
  try {
    const result = await runBrowserDiscovery({
      registry, strategy, tasks: [task], sourceAdapters: adapters, browserAdapter,
      selection: { profile: 'jorge' }, sessionManager: { acquire: () => ({ profile: 'jorge' }), release() {} }, runId: 'strategy-reject', clock,
    });
    assert.equal(result.status, 'SUCCESS'); assert.equal(result.run.observations, 0);
    assert.equal(registry.db.prepare('SELECT COUNT(*) count FROM jobs').get().count, 0);
    const taskState = registry.getBrowserDiscoveryTaskResults('strategy-reject')[0];
    assert.equal(taskState.query, ''); assert.equal(taskState.strategy, 'linkedin_feed'); assert.equal(taskState.rejected, 1); assert.equal(taskState.durationMs, 0);
    assert.deepEqual(registry.getBrowserDiscoveryStrategyMetrics('strategy-reject').map(item => ({ strategy: item.strategy, discovered: item.discovered, valid: item.valid, rejected: item.rejected })), [
      { strategy: 'linkedin_feed', discovered: 1, valid: 1, rejected: 1 },
    ]);
  } finally { registry.close(); }
});

test('strategy metrics attribute downstream eligibility and shortlist to the originating runbook', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock });
  const adapters = browserDiscoverySourceAdapters();
  const task = buildBrowserDiscoveryTasks({
    config: { browser_discovery: { enabled: true } }, adapters,
    strategyTasks: generateDiscoveryStrategyTasks(strategy).filter(item => item.strategyId === 'occ_search' && item.query === 'Ingeniero IA'),
  })[0];
  const browserAdapter = { async start() {}, async close() {}, async discover() { return { retrievedAt: NOW, records: [{
    url: 'https://www.occ.com.mx/empleo/oferta/ai-123', title: 'Ingeniero IA', company: 'Empresa Ejemplo', location: 'Remoto México', description: 'Contrato remoto para sistemas de IA.',
  }] }; } };
  try {
    await runBrowserDiscovery({
      registry, strategy, tasks: [task], sourceAdapters: adapters, browserAdapter,
      selection: { profile: 'jorge' }, sessionManager: { acquire: () => ({ profile: 'jorge' }), release() {} }, runId: 'strategy-shortlist', clock,
    });
    const observation = registry.db.prepare('SELECT id, job_id FROM job_observations').get();
    registry.recordAssessment(observation.job_id, observation.id, {
      eligibility: { status: 'ELIGIBLE', eligibilityScore: 100, confidence: 'high', reasons: ['fixture'], evidence: [], rulesApplied: ['fixture'] },
      candidateFit: { score: 90, reasons: [] }, opportunity: { score: 85, reasons: [] },
      finalPriority: { score: 88, decision: 'SHORTLIST', reasons: [] },
      eligibilityRulesVersion: '1', rankingRulesVersion: '2', profileHash: 'fixture-profile', inputHash: 'fixture-input', calculatedAt: NOW,
    });
    const metrics = registry.getBrowserDiscoveryStrategyMetrics('strategy-shortlist')[0];
    assert.equal(metrics.strategy, 'occ_search'); assert.equal(metrics.eligible, 1); assert.equal(metrics.shortlist, 1);
    assert.equal(metrics.providerRoi, 1);
  } finally { registry.close(); }
});
