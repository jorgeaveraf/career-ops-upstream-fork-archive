import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { hashStable } from '../acquisition/normalize.mjs';
import { ApplicationArtifactWriter } from '../application-enrichment/artifact-writer.mjs';
import { discoverApplicationPath } from '../application-enrichment/plans.mjs';
import { BoundedApplicationResearchProvider } from '../application-enrichment/research-provider.mjs';
import { ApplicationEnrichmentWorker } from '../application-enrichment/worker.mjs';
import { CandidateKnowledgeProvider } from '../candidate-knowledge/provider.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const NOW = '2026-08-25T18:00:00.000Z';
const CV = readFileSync(new URL('../cv.md', import.meta.url), 'utf8');

function action(jobId, value = 'NEXT_STAGE', suffix = value, notes = '') {
  const accepted = [];
  if (notes) accepted.push({ actionKey: `${jobId}:notes:${suffix}`, spreadsheetId: 'sheet', tabName: 'TODAY', entityType: 'JOB', entityId: jobId, field: 'notes', value: notes, observedAt: NOW, user: 'jorge', sourceHash: `notes-${suffix}` });
  accepted.push({ actionKey: `${jobId}:decision:${suffix}`, spreadsheetId: 'sheet', tabName: 'TODAY', entityType: 'JOB', entityId: jobId, field: 'human_decision', value, observedAt: NOW, user: 'jorge', sourceHash: `decision-${suffix}` });
  return { accepted, rejected: [] };
}

function fixture({ suffix = 'apply', description = 'Required qualifications:\n- RAG\n- Python\n- AI systems', url = null } = {}) {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  registry.startRun({ id: `run-${suffix}`, startedAt: NOW });
  const observed = registry.recordObservation(`run-${suffix}`, {
    provider: 'fixture', externalId: suffix, sourceUrl: url || `https://jobs.example.test/${suffix}`,
    title: 'AI Platform Engineer', company: 'Example AI', location: 'Remote Mexico', description, retrievedAt: NOW,
  });
  registry.finishRun(`run-${suffix}`, { finishedAt: NOW });
  registry.recordAssessment(observed.jobId, observed.observationId, {
    eligibilityRulesVersion: '1', rankingRulesVersion: '1', profileHash: 'profile', inputHash: `input-${suffix}`, calculatedAt: NOW,
    eligibility: { status: 'ELIGIBLE', eligibilityScore: 90, confidence: 'high', reasons: [], evidence: [], rulesApplied: [] },
    candidateFit: { score: 90 }, opportunity: { score: 90 }, finalPriority: { score: 90, decision: 'SHORTLIST' },
  });
  registry.recordHumanActions(action(observed.jobId, 'NEXT_STAGE', suffix, 'Preserve this exact decision context.'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-v2b-'));
  const worker = new ApplicationEnrichmentWorker({
    registry, candidateProvider: new CandidateKnowledgeProvider({ projectRoot: ROOT }), canonicalCv: CV,
    artifactWriter: new ApplicationArtifactWriter({ root }), clock: () => new Date(NOW),
  });
  return { registry, observed, worker, root, close() { registry.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('no pending NEXT_STAGE request performs no work or navigation', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  try {
    const worker = new ApplicationEnrichmentWorker({ registry, candidateProvider: new CandidateKnowledgeProvider({ projectRoot: ROOT }), canonicalCv: CV });
    assert.deepEqual(worker.preview(), { status: 'NO_WORK', navigationStarted: false, writes: [] });
    assert.deepEqual(await worker.processNext({ runId: 'empty' }), { status: 'NO_WORK', processed: 0 });
  } finally { registry.close(); }
});

test('NEXT_STAGE reaches READY_FOR_REVIEW with an APPLY-only package and private artifacts', async () => {
  const f = fixture();
  try {
    const result = await f.worker.processNext({ runId: 'worker-apply', useLLM: false });
    assert.equal(result.status, 'READY_FOR_REVIEW');
    assert.equal(result.recommendation, 'APPLY');
    assert.equal(result.packageGenerated, true);
    assert.equal(f.registry.getJobEvaluations(f.observed.jobId).length, 1);
    assert.equal(f.registry.getApplicationPackages(f.observed.jobId).length, 1);
    const request = f.registry.listEnrichmentRequests({ jobId: f.observed.jobId })[0];
    assert.equal(request.humanNotes, 'Preserve this exact decision context.');
    assert.equal(request.applicationPlan.status, 'READY');
    assert.equal(request.contactPlan.status, 'NO_EVIDENCED_CONTACT');
    assert.equal(request.artifactManifest.resumeStatus, 'READY');
    assert.match(request.artifactManifest.files['resume.pdf'].humanFilename, /^Jorge Vera - .+\.pdf$/);
    assert.match(request.artifactManifest.files['cover-letter.pdf'].humanFilename, /^Jorge Vera - .+ - Cover Letter\.pdf$/);
    assert.doesNotMatch(readFileSync(request.artifactManifest.files['resume.md'].path,'utf8'), /Canonical CV|unchanged source/);
    for (const file of Object.values(request.artifactManifest.files)) {
      assert.equal(statSync(file.path).mode & 0o777, 0o600);
      assert.equal(hashStable(readFileSync(file.path, 'utf8')), file.hash);
    }
    assert.deepEqual(f.registry.getEnrichmentRequestEvents(request.id).map(item => item.toStatus), ['PENDING', 'RESEARCHING', 'EVALUATING', 'GENERATING_PACKAGE', 'READY_FOR_REVIEW']);
    const second = await f.worker.processNext({ runId: 'worker-repeat' });
    assert.equal(second.status, 'NO_WORK');
    assert.equal(f.registry.getApplicationPackages(f.observed.jobId).length, 1);
    const today = buildControlPlaneProjection(f.registry.getControlPlaneData({ candidateScope: 'decision' })).tabs.TODAY.find(row=>row['Entity ID']===f.observed.jobId);
    assert.equal(today['Enrichment Status'], 'READY_FOR_REVIEW');
    assert.match(today.Resume, /^=HYPERLINK\("http:\/\/127\.0\.0\.1:4319\/v3f\/artifacts\//);
    assert.equal(today.Contacts, 'BLOCKED');
    assert.match(today['Recommended Action'], /artefactos del paquete/);
    assert.equal(buildControlPlaneProjection(f.registry.getControlPlaneData({ candidateScope: 'decision' })).tabs.APPLICATIONS.length,0);
  } finally { f.close(); }
});

test('DO_NOT_APPLY completes review without generating a package', async () => {
  const f = fixture({ suffix: 'gap', description: 'Required qualifications:\n- Active medical license' });
  try {
    const result = await f.worker.processNext({ runId: 'worker-gap', useLLM: false });
    assert.equal(result.status, 'READY_FOR_REVIEW');
    assert.equal(result.recommendation, 'DO_NOT_APPLY');
    assert.equal(result.packageGenerated, false);
    assert.equal(f.registry.getApplicationPackages(f.observed.jobId).length, 0);
    const request = f.registry.listEnrichmentRequests({ jobId: f.observed.jobId })[0];
    assert.equal(request.packageState, 'NOT_GENERATED');
    assert.equal(request.lastErrorCode, null);
    assert.equal(request.artifactManifest.resumeStatus, 'NOT_GENERATED');
  } finally { f.close(); }
});

test('claims are atomic and expired leases recover with an auditable event', () => {
  const f = fixture({ suffix: 'lease' });
  try {
    const request = f.registry.listEnrichmentRequests({ status: 'PENDING' })[0];
    const first = f.registry.claimNextEnrichmentRequest({ runId: 'one', requestId: request.id, leaseSeconds: 60, at: '2026-08-25T18:00:00.000Z' });
    assert.equal(first.status, 'RESEARCHING');
    assert.equal(f.registry.claimNextEnrichmentRequest({ runId: 'two', requestId: request.id, at: '2026-08-25T18:00:01.000Z' }), null);
    assert.equal(f.registry.recoverExpiredEnrichmentClaims({ at: '2026-08-25T18:02:00.000Z' }), 1);
    assert.equal(f.registry.getEnrichmentRequest(request.id).status, 'PENDING');
    assert.ok(f.registry.getEnrichmentRequestEvents(request.id).some(item => item.reason === 'lease_expired_recovery'));
  } finally { f.close(); }
});

test('READY_FOR_REVIEW cannot be persisted without a normalized completion record',()=>{const f=fixture({suffix:'completion-guard'});try{const request=f.registry.listEnrichmentRequests({status:'PENDING'})[0];f.registry.claimNextEnrichmentRequest({runId:'guard',requestId:request.id});f.registry.transitionEnrichmentRequest(request.id,'EVALUATING',{reason:'research_complete',runId:'guard'});assert.throws(()=>f.registry.transitionEnrichmentRequest(request.id,'READY_FOR_REVIEW',{reason:'invalid_ready',runId:'guard'}),/completion record/);}finally{f.close();}});

test('research identity mismatch is rejected and challenge pages remain blocked', async () => {
  const plan = { budget: { maxPages: 1 }, tasks: [{ id: 'canonical-job', kind: 'JOB_PAGE', sourceType: 'CANONICAL_JOB_PAGE', url: 'https://jobs.example.test/right' }] };
  const input = { request: { id: 'r' }, job: { title: 'AI Engineer', company: 'Right Co', url: 'https://jobs.example.test/right' }, observation: { description: '' }, plan };
  const mismatch = await new BoundedApplicationResearchProvider({ browserAdapter: { async read() { return { text: 'Unrelated accounting vacancy', title: 'Accountant', company: 'Wrong Co', finalUrl: 'https://evil.example/wrong', retrievedAt: NOW, findings: [] }; } }, clock: () => new Date(NOW) }).research(input);
  assert.equal(mismatch.status, 'SUCCESS'); // Registry identity/path evidence remains usable; the mismatched page does not.
  assert.equal(mismatch.report.sourcesAttempted[0].status, 'IDENTITY_UNCERTAIN');
  assert.equal(mismatch.evidence.some(item => item.normalizedField === 'description'), false);
  const challenge = await new BoundedApplicationResearchProvider({ browserAdapter: { async read() { return { text: 'Verify you are human — Cloudflare security challenge', finalUrl: input.job.url, retrievedAt: NOW, findings: [] }; } }, clock: () => new Date(NOW) }).research(input);
  assert.equal(challenge.status, 'BLOCKED');
  assert.equal(challenge.failureCode, 'CHALLENGE');
});

test('application path distinguishes ATS and email evidence without executing either', () => {
  assert.equal(discoverApplicationPath({ job: { url: 'https://boards.greenhouse.io/acme/jobs/1' } }).primaryPath, 'ATS');
  const email = discoverApplicationPath({ job: {}, evidence: [{ id: 'e1', normalizedField: 'application_path', identityStatus: 'CONFIRMED', value: { email: 'jobs@example.test' } }] });
  assert.equal(email.primaryPath, 'EMAIL');
  assert.equal(email.email, 'jobs@example.test');
  assert.match(email.primaryAction, /Prepare email/);
});

test('Ashby application path targets the official form instead of the overview CTA', () => {
  const plan = discoverApplicationPath({ job: { url: 'https://jobs.ashbyhq.com/acme/role-123' }, evidence: [] });
  assert.equal(plan.primaryPath, 'ATS');
  assert.equal(plan.url, 'https://jobs.ashbyhq.com/acme/role-123/application');
});

test('materially new evidence creates a new evaluation/package version; contact and optional cover remain evidence-driven', async () => {
  const f = fixture({ suffix: 'versioned' });
  try {
    const first = await f.worker.processNext({ runId: 'version-one', useLLM: false });
    const request = f.registry.getEnrichmentRequest(first.requestId);
    f.registry.transitionEnrichmentRequest(request.id, 'PENDING', { reason: 'material_evidence_retry', runId: 'human-review' });
    const source = { providerId: 'fixture', providerVersion: '1', sourceType: 'PUBLIC_PROFILE', sourceUrl: 'https://profiles.example.test/jane', sourceHash: 'profile-jane', retrievedAt: NOW };
    const raw = 'Required qualifications: RAG, Python, AI systems, TypeScript';
    f.worker.researchProvider = { async research({ job }) { return {
      status: 'SUCCESS', failureCode: null, coverLetterRequired: false,
      evidence: [{ id: 'new-description', sourceUrl: job.url, sourceType: 'CANONICAL_JOB_PAGE', fetchedAt: NOW, extractionMethod: 'fixture', rawSnippet: raw, rawHash: hashStable(raw), normalizedField: 'description', value: raw, confidence: 'HIGH', identityStatus: 'CONFIRMED', resolverVersion: 'fixture-1' }],
      contacts: [{ ref: 'jane', name: 'Jane Doe', role: 'Technical Recruiter', profileUrl: source.sourceUrl, relationship: 'RECRUITER', evidence: [
        { field: 'name', value: 'Jane Doe', confidence: 'HIGH', extractionMethod: 'DIRECT', source },
        { field: 'company', value: 'Example AI', confidence: 'HIGH', extractionMethod: 'DIRECT', source },
        { field: 'role', value: 'Technical Recruiter', confidence: 'HIGH', extractionMethod: 'DIRECT', source },
        { field: 'profile_url', value: source.sourceUrl, confidence: 'HIGH', extractionMethod: 'DIRECT', source },
      ], relationshipEvidence: [{ field: 'relationship', value: 'RECRUITER', confidence: 'HIGH', extractionMethod: 'DIRECT', source }] }],
      report: { version: '1', sourcesAttempted: [], sourcesSuccessful: 1, sourcesBlocked: [], evidenceCount: 1, contactsFound: 1, descriptionComplete: true, applicationPathFound: true, startedAt: NOW, finishedAt: NOW, durationMs: 0, usage: { llmCalls: 0, tokens: 0 } },
    }; } };
    const second = await f.worker.processNext({ runId: 'version-two', useLLM: false });
    assert.equal(second.status, 'READY_FOR_REVIEW');
    assert.equal(f.registry.getJobEvaluations(f.observed.jobId).length, 2);
    assert.deepEqual(f.registry.getApplicationPackages(f.observed.jobId).map(item => item.packageVersion), [1, 2]);
    const updated = f.registry.getEnrichmentRequest(request.id);
    assert.equal(updated.artifactManifest.coverLetterStatus, 'NOT_NEEDED');
    assert.equal(updated.contactPlan.status, 'READY');
    assert.equal(updated.contactPlan.target, 'Jane Doe');
    assert.ok(updated.contactPlan.evidenceRefs.length > 0);
  } finally { f.close(); }
});
