import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { CandidateKnowledgeProvider } from '../candidate-knowledge/provider.mjs';

function writeYaml(file, value) {
  writeFileSync(file, yaml.dump(value, { lineWidth: 120, noRefs: true }));
}

function fixture({ version = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-candidate-kb-'));
  const candidate = join(root, 'candidate');
  mkdirSync(candidate, { recursive: true });
  writeYaml(join(root, 'profile.yml'), {
    target_roles: { primary: ['Knowledge Systems Engineer'], alternatives: ['Data Engineer'], seniority: { preferred: ['Senior'] } },
    search_preferences: { work_location: { accepted: ['Remote'] } },
    compensation: { by_employment_type: { contract: { minimum: 50, currency: 'USD', period: 'hour' } } },
  });
  writeFileSync(join(root, 'cv.md'), '# Fictional Candidate\nBuilt a cited retrieval system.\n');
  const manifest = {
    schema_version: 1, kb_version: version,
    metadata: { updated_at: '2026-08-22T12:00:00Z', content_hash: 'pending', generation_method: 'fictional test fixture' },
    sources: [
      { id: 'cv', path: 'cv.md', authority: 'confirmed' },
      { id: 'profile', path: 'profile.yml', authority: 'confirmed' },
    ],
    sections: {
      identity: 'identity.yml', experience: 'experience.yml', projects: 'projects.yml', skills: 'skills.yml',
      stories: 'stories.yml', gaps: 'gaps.yml', preferences: 'preferences.yml', evidence: 'evidence.yml',
    },
  };
  writeYaml(join(candidate, 'manifest.yml'), manifest);
  writeYaml(join(candidate, 'identity.yml'), { identity: {
    primary_title: 'Knowledge Systems Engineer', alternative_titles: ['Data Engineer'], seniority: 'Senior',
    positioning: 'Builds cited retrieval systems.', domains: ['knowledge systems'], target_role_types: ['technical'],
    evidence_refs: ['claim.rag'],
  } });
  writeYaml(join(candidate, 'experience.yml'), { experience: [{
    id: 'exp.acme', company: 'Acme', role: 'Engineer', start: '2024-01', end: 'present', domains: ['knowledge systems'],
    responsibility_claim_refs: ['claim.rag'], project_refs: ['project.rag'],
  }] });
  writeYaml(join(candidate, 'projects.yml'), { projects: [{
    id: 'project.rag', name: 'Cited retrieval', category: 'AI Systems', experience_ref: 'exp.acme',
    business_problem: 'Find supported answers.', capabilities: ['RAG'], architecture: ['retrieval pipeline'], technologies: ['RAG'],
    decisions: [], outcomes: ['System delivered.'], evidence_refs: ['claim.rag'], story_refs: ['story.rag'],
  }] });
  writeYaml(join(candidate, 'skills.yml'), { skills: [{
    id: 'skill.rag', name: 'RAG', aliases: ['retrieval-augmented generation'], level: 'demonstrated', confidence: 'high',
    contexts: ['cited retrieval'], project_refs: ['project.rag'], evidence_refs: ['claim.rag'], story_refs: ['story.rag'],
  }] });
  writeYaml(join(candidate, 'stories.yml'), { stories: [{
    id: 'story.rag', title: 'Cited retrieval', completeness: 'PARTIAL', situation: null, action: 'Built retrieval.',
    technical_decisions: [], result: 'Delivered.', project_refs: ['project.rag'], skill_refs: ['skill.rag'],
    evidence_refs: ['claim.rag'], gap_refs: ['gap.measurement'],
  }] });
  writeYaml(join(candidate, 'gaps.yml'), { gaps: [{
    id: 'gap.measurement', topic: 'RAG measurement', status: 'UNKNOWN', confidence: 'high', evidence_refs: ['claim.rag'],
    limitation: 'Measurement method is not documented.', safe_usage: 'Do not invent it.',
  }, {
    id: 'gap.kubernetes', topic: 'Kubernetes', status: 'UNKNOWN', confidence: 'high', evidence_refs: [],
    limitation: 'Approved sources do not document Kubernetes.', safe_usage: 'Ask or omit.',
  }] });
  writeYaml(join(candidate, 'preferences.yml'), { preferences: {
    source_id: 'profile', mappings: { primary_roles: 'target_roles.primary', compensation: 'compensation.by_employment_type' },
    duplication_policy: 'resolve_from_source',
  } });
  writeYaml(join(candidate, 'evidence.yml'), { claims: [{
    id: 'claim.rag', claim: 'Built a cited retrieval system.', status: 'CONFIRMED',
    confidence: 'high', source_refs: [{ source_id: 'cv', locator: 'line 2' }], entity_refs: ['exp.acme', 'project.rag'],
  }] });
  const loose = new CandidateKnowledgeProvider({ root: 'candidate', projectRoot: root, strictHash: false });
  const hash = loose.load().metadata.hash;
  manifest.metadata.content_hash = hash;
  writeYaml(join(candidate, 'manifest.yml'), manifest);
  return { root, candidate, hash };
}

test('candidate loading validates topology and exposes deterministic metadata', () => {
  const fx = fixture();
  try {
    const provider = new CandidateKnowledgeProvider({ projectRoot: fx.root });
    const first = provider.load();
    const second = new CandidateKnowledgeProvider({ projectRoot: fx.root }).load();
    assert.equal(first.metadata.hash, fx.hash);
    assert.equal(first.metadata.revision, `1:${fx.hash.slice(0, 12)}`);
    assert.deepEqual(first, second);
    assert.deepEqual(first.identity.alternative_titles, ['Data Engineer']);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('evidence retrieval for RAG returns projects, claims, stories, and documented limits', () => {
  const fx = fixture();
  try {
    const provider = new CandidateKnowledgeProvider({ projectRoot: fx.root });
    const result = provider.findEvidence('retrieval-augmented generation');
    assert.equal(result.status, 'CONFIRMED');
    assert.equal(result.skill.name, 'RAG');
    assert.deepEqual(result.projects.map(item => item.id), ['project.rag']);
    assert.deepEqual(result.evidence.map(item => item.id), ['claim.rag']);
    assert.deepEqual(result.stories.map(item => item.id), ['story.rag']);
    assert.deepEqual(result.gaps.map(item => item.id), ['gap.measurement']);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('unknown knowledge never becomes a claim and an existing gap stays a gap', () => {
  const fx = fixture();
  try {
    const provider = new CandidateKnowledgeProvider({ projectRoot: fx.root });
    const kubernetes = provider.findEvidence('Kubernetes');
    const rust = provider.findEvidence('Rust');
    assert.equal(kubernetes.status, 'UNKNOWN');
    assert.equal(kubernetes.evidence.length, 0);
    assert.equal(kubernetes.gaps[0].status, 'UNKNOWN');
    assert.match(kubernetes.gaps[0].safe_usage, /Ask or omit/);
    assert.deepEqual(rust, {
      status: 'UNKNOWN', query: 'Rust', skill: null, projects: [], evidence: [], stories: [], gaps: [],
      explanation: 'No approved candidate evidence supports this topic.',
    });
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('preferences resolve from the canonical profile instead of duplicating values', () => {
  const fx = fixture();
  try {
    const provider = new CandidateKnowledgeProvider({ projectRoot: fx.root });
    assert.deepEqual(provider.getPreferences(), {
      primary_roles: ['Knowledge Systems Engineer'],
      compensation: { contract: { minimum: 50, currency: 'USD', period: 'hour' } },
    });
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('content edits change the hash and intentional KB version changes the revision', () => {
  const v1 = fixture({ version: 1 });
  const v2 = fixture({ version: 2 });
  try {
    const first = new CandidateKnowledgeProvider({ projectRoot: v1.root }).load();
    const second = new CandidateKnowledgeProvider({ projectRoot: v2.root }).load();
    assert.notEqual(first.metadata.hash, second.metadata.hash);
    assert.equal(first.metadata.version, 1);
    assert.equal(second.metadata.version, 2);
    assert.match(second.metadata.revision, /^2:/);

    writeFileSync(join(v1.root, 'cv.md'), `${readFileSync(join(v1.root, 'cv.md'), 'utf8')}Changed source.\n`);
    assert.throws(
      () => new CandidateKnowledgeProvider({ projectRoot: v1.root }).load(),
      /content hash mismatch/,
    );
  } finally {
    rmSync(v1.root, { recursive: true, force: true });
    rmSync(v2.root, { recursive: true, force: true });
  }
});

test('inferred knowledge cannot masquerade as high-confidence evidence', () => {
  const fx = fixture();
  try {
    const evidencePath = join(fx.candidate, 'evidence.yml');
    const evidence = yaml.load(readFileSync(evidencePath, 'utf8'));
    evidence.claims[0].status = 'INFERRED';
    writeYaml(evidencePath, evidence);
    assert.throws(
      () => new CandidateKnowledgeProvider({ projectRoot: fx.root, strictHash: false }).load(),
      /inferred claim cannot have high confidence/,
    );
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('provider is read-only and contains no registry, LLM, embedding, or vector dependency', () => {
  const source = readFileSync(new URL('../candidate-knowledge/provider.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /better-sqlite3|JobRegistry|openai|anthropic|gemini|embedding|vector database/i);
  assert.doesNotMatch(source, /writeFile|appendFile|unlink|rmSync/);
});
