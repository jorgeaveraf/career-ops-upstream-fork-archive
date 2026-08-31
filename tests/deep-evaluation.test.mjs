import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { CandidateKnowledgeProvider } from '../candidate-knowledge/provider.mjs';
import { DeepEvaluationEngine } from '../deep-evaluation/engine.mjs';
import { OpenAIResponsesProvider, StructuredGenerationProvider } from '../deep-evaluation/llm-provider.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const NOW = '2026-08-22T12:00:00.000Z';
const shortlisted = { id: 'assessment.fixture', observationId: 'observation.fixture', decision: 'SHORTLIST' };
const candidate = () => new CandidateKnowledgeProvider({ projectRoot: new URL('..', import.meta.url).pathname });

function job(description, overrides = {}) {
  return { id: 'job.fixture', observationId: 'observation.fixture', title: 'Senior AI Systems Engineer', company: 'Example', location: 'Remote worldwide', description, ...overrides };
}

test('strong RAG, Python, and AI systems evidence produces STRONG matches and APPLY without an LLM', async () => {
  const engine = new DeepEvaluationEngine({ candidateProvider: candidate(), clock: () => new Date(NOW) });
  const artifact = await engine.evaluate({
    job: job('Required qualifications:\n- RAG\n- Python\n- Experience building AI systems'), assessment: shortlisted, useLLM: false,
  });
  assert.equal(artifact.status, 'VALID');
  assert.equal(artifact.evaluation.recommendation, 'APPLY');
  assert.equal(artifact.provenance.providerId, 'deterministic');
  for (const label of ['RAG', 'Python', 'AI systems']) {
    assert.equal(artifact.evidenceMatches.find(item => item.requirement.label === label)?.status, 'STRONG_MATCH');
  }
});

test('Kubernetes is only PARTIAL when approved evidence proves Docker but not Kubernetes', async () => {
  const artifact = await new DeepEvaluationEngine({ candidateProvider: candidate() }).evaluate({
    job: job('Required qualifications:\n- Kubernetes\n- Docker'), assessment: shortlisted, useLLM: false,
  });
  const match = artifact.evidenceMatches.find(item => item.requirement.label === 'Kubernetes');
  assert.equal(match.status, 'PARTIAL_MATCH');
  assert.ok(match.projectIds.includes('project.financial_saas'));
  assert.ok(match.gapIds.includes('gap.kubernetes'));
  assert.match(match.note, /does not prove Kubernetes/i);
});

test('specific ML model training remains NO_EVIDENCE', async () => {
  const artifact = await new DeepEvaluationEngine({ candidateProvider: candidate() }).evaluate({
    job: job('Required qualifications:\n- Hands-on ML model training'), assessment: shortlisted, useLLM: false,
  });
  assert.equal(artifact.evidenceMatches.find(item => item.requirement.label === 'ML model training')?.status, 'NO_EVIDENCE');
});

test('job analysis and evidence retrieval are deterministic without an LLM', async () => {
  const engine = new DeepEvaluationEngine({ candidateProvider: candidate(), clock: () => new Date(NOW) });
  const input = { job: job('Required qualifications:\n- RAG\nPreferred:\n- Kubernetes'), assessment: shortlisted, useLLM: false };
  const first = await engine.evaluate(input);
  const second = await engine.evaluate(structuredClone(input));
  assert.deepEqual(first.jobAnalysis, second.jobAnalysis);
  assert.deepEqual(first.evidenceMatches, second.evidenceMatches);
  assert.equal(first.evaluationKey, second.evaluationKey);
});

class FixtureProvider extends StructuredGenerationProvider {
  constructor(data, model = 'fixture-model') { super({ id: 'fixture', model }); this.data = data; this.calls = 0; }
  async generateStructured() { this.calls += 1; return { data: structuredClone(this.data), providerId: this.id, model: this.model }; }
}

function hallucinatedOutput() {
  return {
    recommendation: 'APPLY', confidence: 'HIGH', overall_fit: 95, summary: 'Excellent fit.',
    strengths: [{ requirement_id: 'req.kubernetes', evidence_ids: ['claim.hq.financial_saas'], summary: 'Kubernetes expert with extensive production experience.' }],
    evidence_used: ['claim.hq.financial_saas'], gaps: [],
    positioning: { emphasize: [], avoid: [] }, interview_focus: [], risks: [],
  };
}

test('post-LLM validation rejects an invented Kubernetes expertise claim', async () => {
  const llm = new FixtureProvider(hallucinatedOutput());
  const artifact = await new DeepEvaluationEngine({ candidateProvider: candidate(), llmProvider: llm }).evaluate({
    job: job('Required qualifications:\n- Kubernetes'), assessment: shortlisted,
  });
  assert.equal(llm.calls, 1);
  assert.equal(artifact.status, 'REJECTED');
  assert.equal(artifact.evaluation, null);
  assert.match(artifact.validation.errors.join(' '), /overstates partial evidence/i);
});

test('a gap ID cannot be used as positive strength evidence', async () => {
  const output = hallucinatedOutput();
  output.strengths[0] = { requirement_id: 'req.kubernetes', evidence_ids: ['gap.kubernetes'], summary: 'Related Kubernetes evidence.' };
  output.evidence_used = ['gap.kubernetes'];
  const artifact = await new DeepEvaluationEngine({ candidateProvider: candidate(), llmProvider: new FixtureProvider(output) }).evaluate({
    job: job('Required qualifications:\n- Kubernetes'), assessment: shortlisted,
  });
  assert.equal(artifact.status, 'REJECTED');
  assert.match(artifact.validation.errors.join(' '), /unsupported evidence: gap\.kubernetes/i);
});

test('cost gate blocks non-SHORTLIST jobs before calling the provider', async () => {
  const llm = new FixtureProvider(hallucinatedOutput());
  const engine = new DeepEvaluationEngine({ candidateProvider: candidate(), llmProvider: llm });
  await assert.rejects(() => engine.evaluate({ job: job('Kubernetes'), assessment: { decision: 'CONSIDER' } }), error => {
    assert.equal(error.code, 'DEEP_EVALUATION_NOT_SHORTLISTED'); return true;
  });
  assert.equal(llm.calls, 0);
});

test('prompt, model, and candidate KB hash changes alter evaluation identity', async () => {
  const base = candidate();
  const a = await new DeepEvaluationEngine({ candidateProvider: base, promptVersion: '1' }).evaluate({ job: job('Python'), assessment: shortlisted, useLLM: false });
  const b = await new DeepEvaluationEngine({ candidateProvider: base, promptVersion: '2' }).evaluate({ job: job('Python'), assessment: shortlisted, useLLM: false });
  const proxy = {
    getMetadata: () => ({ ...base.getMetadata(), hash: 'different-kb-hash', revision: '2:different' }),
    getSnapshot: () => base.getSnapshot(), findEvidence: query => base.findEvidence(query),
  };
  const c = await new DeepEvaluationEngine({ candidateProvider: proxy, promptVersion: '1' }).evaluate({ job: job('Python'), assessment: shortlisted, useLLM: false });
  const valid = (await new DeepEvaluationEngine({ candidateProvider: base }).evaluate({ job: job('Python'), assessment: shortlisted, useLLM: false })).evaluation;
  const d = await new DeepEvaluationEngine({ candidateProvider: base, llmProvider: new FixtureProvider(valid, 'model-a') }).evaluate({ job: job('Python'), assessment: shortlisted });
  const e = await new DeepEvaluationEngine({ candidateProvider: base, llmProvider: new FixtureProvider(valid, 'model-b') }).evaluate({ job: job('Python'), assessment: shortlisted });
  assert.equal(new Set([a.evaluationKey, b.evaluationKey, c.evaluationKey, d.evaluationKey, e.evaluationKey]).size, 5);
});

test('registry is the sole writer and keeps job evaluations separate from assessments', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  try {
    registry.startRun({ id: 'run', startedAt: NOW });
    const observed = registry.recordObservation('run', {
      provider: 'fixture', externalId: 'deep-1', sourceUrl: 'https://jobs.example.test/deep-1',
      title: 'AI Engineer', company: 'Example', location: 'Remote worldwide', description: 'Required: RAG and Python', retrievedAt: NOW,
    });
    registry.finishRun('run', { finishedAt: NOW });
    const assessment = registry.recordAssessment(observed.jobId, observed.observationId, {
      eligibilityRulesVersion: '1', rankingRulesVersion: '1', profileHash: 'profile', inputHash: 'input', calculatedAt: NOW,
      eligibility: { status: 'ELIGIBLE', eligibilityScore: 90, confidence: 'high', reasons: [], evidence: [], rulesApplied: [] },
      candidateFit: { score: 90 }, opportunity: { score: 90 }, finalPriority: { score: 90, decision: 'SHORTLIST' },
    });
    const candidateRow = registry.listDeepEvaluationCandidates({ jobId: observed.jobId })[0];
    assert.equal(candidateRow.assessment.id, assessment.id);
    const artifact = await new DeepEvaluationEngine({ candidateProvider: candidate(), clock: () => new Date(NOW) })
      .evaluate({ job: candidateRow.job, assessment: candidateRow.assessment, useLLM: false });
    const stored = registry.recordJobEvaluation(artifact);
    const duplicate = registry.recordJobEvaluation(artifact);
    assert.equal(stored.status, 'VALID');
    assert.equal(duplicate.id, stored.id);
    assert.equal(duplicate.existing, true);
    assert.equal(registry.getJobEvaluations(observed.jobId).length, 1);
    assert.equal(registry.getAssessments(observed.jobId).length, 1);
  } finally { registry.close(); }
});

test('OpenAI adapter requests strict structured output with storage disabled', async () => {
  let request;
  const provider = new OpenAIResponsesProvider({ model: 'explicit-test-model', apiKey: 'test-key', fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ id: 'resp_1', model: 'explicit-test-model', output_text: '{"ok":true}', usage: { input_tokens: 1 } }) };
  } });
  const result = await provider.generateStructured({ instructions: 'test', input: { a: 1 }, schema: { type: 'object' }, name: 'test_schema' });
  assert.equal(result.data.ok, true);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.body.text.format.strict, true);
});

test('deep evaluation engine has no direct SQLite dependency', () => {
  for (const file of ['engine.mjs', 'job-analysis.mjs', 'evidence-matcher.mjs', 'validation.mjs', 'prompt.mjs', 'llm-provider.mjs']) {
    const source = readFileSync(new URL(`../deep-evaluation/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /better-sqlite3|JobRegistry/);
  }
});
