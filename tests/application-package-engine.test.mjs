import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { CandidateKnowledgeProvider } from '../candidate-knowledge/provider.mjs';
import { DeepEvaluationEngine } from '../deep-evaluation/engine.mjs';
import { StructuredGenerationProvider } from '../deep-evaluation/llm-provider.mjs';
import { ApplicationPackageEngine } from '../application-package/engine.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const NOW = '2026-08-22T12:00:00.000Z';
const CV = readFileSync(new URL('../cv.md', import.meta.url), 'utf8');
const candidate = () => new CandidateKnowledgeProvider({ projectRoot: ROOT });
const job = (overrides = {}) => ({
  id: 'job.fixture', observationId: 'observation.fixture', title: 'AI Platform Engineer', company: 'Example AI',
  location: 'Remote worldwide', description: 'Required qualifications:\n- RAG\n- Python\n- AI systems', ...overrides,
});

async function evaluated(provider = candidate()) {
  return new DeepEvaluationEngine({ candidateProvider: provider, clock: () => new Date(NOW) }).evaluate({
    job: job(), assessment: { id: 'assessment.fixture', decision: 'SHORTLIST' }, useLLM: false,
  });
}

test('resume variant highlights evaluated AI evidence without replacing the canonical CV', async () => {
  const beforeCv = readFileSync(new URL('../cv.md', import.meta.url), 'utf8');
  const beforeManifest = readFileSync(new URL('../candidate/manifest.yml', import.meta.url), 'utf8');
  const provider = candidate();
  const evaluation = await evaluated(provider);
  const artifact = await new ApplicationPackageEngine({ candidateProvider: provider, clock: () => new Date(NOW) })
    .generate({ evaluationArtifact: evaluation, canonicalCv: CV, useLLM: false });
  assert.equal(artifact.status, 'DRAFT');
  assert.equal(artifact.validation.valid, true);
  assert.match(artifact.artifacts.resume_variant.summary.text, /AI Platform Engineer.*Example AI/);
  assert.ok(artifact.artifacts.resume_variant.highlighted_skills.some(item => item.name === 'RAG'));
  assert.ok(artifact.artifacts.resume_variant.selected_projects.some(item => item.project_id === 'project.rag_enrichment'));
  assert.match(artifact.artifacts.resume_variant.changes_from_base.at(-1).change, /preserve remaining canonical experience/i);
  assert.equal(readFileSync(new URL('../cv.md', import.meta.url), 'utf8'), beforeCv);
  assert.equal(readFileSync(new URL('../candidate/manifest.yml', import.meta.url), 'utf8'), beforeManifest);
});

test('cover letter is composed from sourced paragraphs with valid evidence references', async () => {
  const provider = candidate();
  const artifact = await new ApplicationPackageEngine({ candidateProvider: provider })
    .generate({ evaluationArtifact: await evaluated(provider), canonicalCv: CV, useLLM: false });
  const cover = artifact.artifacts.cover_letter;
  assert.equal(cover.content, cover.paragraphs.map(item => item.text).join('\n\n'));
  assert.ok(cover.evidence_refs.length > 0);
  assert.ok(cover.paragraphs.some(item => item.purpose === 'relevant_experience' && item.evidence_refs.length > 0));
  assert.ok(cover.evidence_refs.every(id => artifact.evidenceUsed.includes(id)));
});

test('outreach drafts are personalized and remain drafts', async () => {
  const provider = candidate();
  const artifact = await new ApplicationPackageEngine({ candidateProvider: provider })
    .generate({ evaluationArtifact: await evaluated(provider), canonicalCv: CV, useLLM: false });
  assert.deepEqual(artifact.artifacts.outreach.map(item => item.type), ['RECRUITER_MESSAGE', 'HIRING_MANAGER_MESSAGE', 'EMAIL_INTRODUCTION']);
  for (const draft of artifact.artifacts.outreach) {
    assert.match(`${draft.subject} ${draft.content}`, /AI Platform Engineer/);
    assert.match(`${draft.subject} ${draft.content}`, /Example AI/);
    assert.ok(draft.evidence_refs.length > 0);
  }
});

class FixtureProvider extends StructuredGenerationProvider {
  constructor(data, model = 'fixture-model') { super({ id: 'fixture', model }); this.data = data; }
  async generateStructured() { return { data: structuredClone(this.data), providerId: this.id, model: this.model }; }
}

test('post-generation validation rejects unsupported Kubernetes expertise', async () => {
  const provider = candidate();
  const evaluation = await evaluated(provider);
  const baseline = await new ApplicationPackageEngine({ candidateProvider: provider })
    .generate({ evaluationArtifact: evaluation, canonicalCv: CV, useLLM: false });
  const output = structuredClone(baseline.artifacts);
  output.cover_letter.paragraphs[1].text = 'I am a Kubernetes expert with extensive production experience.';
  output.cover_letter.content = output.cover_letter.paragraphs.map(item => item.text).join('\n\n');
  const artifact = await new ApplicationPackageEngine({ candidateProvider: provider, llmProvider: new FixtureProvider(output) })
    .generate({ evaluationArtifact: evaluation, canonicalCv: CV });
  assert.equal(artifact.status, 'REVIEW_REQUIRED');
  assert.equal(artifact.validationStatus, 'REJECTED');
  assert.equal(artifact.artifacts, null);
  assert.match(artifact.validation.errors.join(' '), /unsupported expertise positioning/i);
});

test('unsupported metrics and evidence IDs are rejected', async () => {
  const provider = candidate();
  const evaluation = await evaluated(provider);
  const baseline = await new ApplicationPackageEngine({ candidateProvider: provider })
    .generate({ evaluationArtifact: evaluation, canonicalCv: CV, useLLM: false });
  const output = structuredClone(baseline.artifacts);
  output.resume_variant.summary.text = 'Led 20 engineers and improved performance by 99%.';
  output.resume_variant.summary.evidence_refs = ['project.fake'];
  const artifact = await new ApplicationPackageEngine({ candidateProvider: provider, llmProvider: new FixtureProvider(output) })
    .generate({ evaluationArtifact: evaluation, canonicalCv: CV });
  assert.equal(artifact.validationStatus, 'REJECTED');
  assert.match(artifact.validation.errors.join(' '), /project\.fake/);
  assert.match(artifact.validation.errors.join(' '), /unsupported metric/i);
});

test('KB hash, CV hash, and prompt version each change package identity', async () => {
  const base = candidate();
  const evaluation = await evaluated(base);
  const a = await new ApplicationPackageEngine({ candidateProvider: base, promptVersion: '1' }).generate({ evaluationArtifact: evaluation, canonicalCv: CV, useLLM: false });
  const b = await new ApplicationPackageEngine({ candidateProvider: base, promptVersion: '2' }).generate({ evaluationArtifact: evaluation, canonicalCv: CV, useLLM: false });
  const c = await new ApplicationPackageEngine({ candidateProvider: base, promptVersion: '1' }).generate({ evaluationArtifact: evaluation, canonicalCv: `${CV}\nSupported source note.`, useLLM: false });
  const proxy = {
    getMetadata: () => ({ ...base.getMetadata(), hash: 'changed-kb', revision: '2:changed' }),
    getSnapshot: () => base.getSnapshot(),
  };
  const d = await new ApplicationPackageEngine({ candidateProvider: proxy, promptVersion: '1' }).generate({ evaluationArtifact: evaluation, canonicalCv: CV, useLLM: false });
  assert.equal(new Set([a.packageKey, b.packageKey, c.packageKey, d.packageKey]).size, 4);
});

test('same inputs produce identical structured output and identity', async () => {
  const provider = candidate();
  const evaluation = await evaluated(provider);
  const engine = new ApplicationPackageEngine({ candidateProvider: provider, clock: () => new Date(NOW) });
  const a = await engine.generate({ evaluationArtifact: evaluation, canonicalCv: CV, useLLM: false });
  const b = await engine.generate({ evaluationArtifact: structuredClone(evaluation), canonicalCv: CV, useLLM: false });
  assert.deepEqual(a, b);
});

test('only VALID APPLY evaluations may produce a package', async () => {
  const provider = candidate();
  const evaluation = await evaluated(provider);
  evaluation.evaluation.recommendation = 'CONSIDER';
  await assert.rejects(
    () => new ApplicationPackageEngine({ candidateProvider: provider }).generate({ evaluationArtifact: evaluation, canonicalCv: CV, useLLM: false }),
    error => error.code === 'PACKAGE_EVALUATION_NOT_APPLY',
  );
});

test('registry preserves package versions and approval is an explicit human-review transition', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  try {
    registry.startRun({ id: 'run', startedAt: NOW });
    const observed = registry.recordObservation('run', { provider: 'fixture', externalId: 'package-1', sourceUrl: 'https://jobs.example.test/package-1', ...job(), retrievedAt: NOW });
    registry.finishRun('run', { finishedAt: NOW });
    const assessment = registry.recordAssessment(observed.jobId, observed.observationId, {
      eligibilityRulesVersion: '1', rankingRulesVersion: '1', profileHash: 'profile', inputHash: 'input', calculatedAt: NOW,
      eligibility: { status: 'ELIGIBLE', eligibilityScore: 90, confidence: 'high', reasons: [], evidence: [], rulesApplied: [] },
      candidateFit: { score: 90 }, opportunity: { score: 90 }, finalPriority: { score: 90, decision: 'SHORTLIST' },
    });
    const provider = candidate();
    const deep = await new DeepEvaluationEngine({ candidateProvider: provider, clock: () => new Date(NOW) }).evaluate({
      job: { ...job(), id: observed.jobId, observationId: observed.observationId }, assessment, useLLM: false,
    });
    const storedEvaluation = registry.recordJobEvaluation(deep);
    const engine = new ApplicationPackageEngine({ candidateProvider: provider, clock: () => new Date(NOW) });
    const firstArtifact = await engine.generate({ evaluationArtifact: storedEvaluation, canonicalCv: CV, useLLM: false });
    const first = registry.recordApplicationPackage(firstArtifact);
    const duplicate = registry.recordApplicationPackage(firstArtifact);
    const secondArtifact = await new ApplicationPackageEngine({ candidateProvider: provider, promptVersion: '2', clock: () => new Date(NOW) })
      .generate({ evaluationArtifact: storedEvaluation, canonicalCv: CV, useLLM: false });
    const second = registry.recordApplicationPackage(secondArtifact);
    assert.equal(first.packageVersion, 1);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.existing, true);
    assert.equal(second.packageVersion, 2);
    const approved = registry.updateApplicationPackageStatus(second.id, 'APPROVED');
    assert.equal(approved.status, 'APPROVED');
    assert.equal(registry.getApplicationPackages(observed.jobId).length, 2);
    assert.equal(registry.getJobEvaluations(observed.jobId).length, 1);
  } finally { registry.close(); }
});

test('package layer has no persistence, file-write, send, apply, or submit capability', () => {
  for (const file of ['engine.mjs', 'validation.mjs', 'prompt.mjs', 'evidence-context.mjs', 'cv-source.mjs', 'contracts.mjs']) {
    const source = readFileSync(new URL(`../application-package/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /better-sqlite3|JobRegistry|writeFile|appendFile|unlink|rmSync/);
    assert.doesNotMatch(source, /\b(?:send|submit|apply)\s*\(/i);
  }
});
