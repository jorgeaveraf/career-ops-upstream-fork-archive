import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { ContactDiscoveryProvider } from '../contact-intelligence/contracts.mjs';
import { ContactIntelligenceEngine } from '../contact-intelligence/engine.mjs';
import { buildApplicationPackageContactContext } from '../contact-intelligence/integration.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const NOW = '2026-08-22T12:00:00.000Z';
const source = (sourceHash, sourceType = 'PUBLIC_TEAM_PAGE') => ({
  sourceType, sourceUrl: 'https://acme.example/team', sourceHash, retrievedAt: NOW,
});
const evidence = (field, value, confidence, sourceHash, sourceType) => ({ field, value, confidence, source: source(sourceHash, sourceType) });

class FixtureContactProvider extends ContactDiscoveryProvider {
  constructor({ companyHash = 'company-v1', people = null, relationships = null } = {}) {
    super({ id: 'public-fixture', version: '1' });
    this.companyHash = companyHash;
    this.people = people || [
      { ref: 'jane', name: 'Jane Rivera', role: 'Technical Recruiter', profileUrl: 'https://acme.example/team/jane', evidence: [
        evidence('name', 'Jane Rivera', 'HIGH', 'jane-name'), evidence('company', 'Acme Labs', 'HIGH', 'jane-company'), evidence('role', 'Technical Recruiter', 'HIGH', 'jane-role'),
        evidence('profile_url', 'https://acme.example/team/jane', 'HIGH', 'jane-profile'),
      ] },
    ];
    this.relationships = relationships || [];
  }
  async findCompany() {
    return { company: { name: 'Acme Labs', domain: 'acme.example', industry: 'AI infrastructure', careersUrl: 'https://acme.example/careers' }, evidence: [
      evidence('name', 'Acme Labs', 'HIGH', this.companyHash, 'COMPANY_PAGE'),
      evidence('domain', 'acme.example', 'HIGH', this.companyHash, 'COMPANY_PAGE'),
      evidence('industry', 'AI infrastructure', 'MEDIUM', this.companyHash, 'COMPANY_PAGE'),
      evidence('careers_url', 'https://acme.example/careers', 'HIGH', this.companyHash, 'COMPANY_CAREERS_PAGE'),
    ] };
  }
  async findPeople() { return this.people; }
  async findRelationships() { return this.relationships; }
}

const job = (id = 'job-1') => ({ id, company: 'Acme Labs' });
const observation = (hash = 'job-source-v1') => ({ company: 'Acme Labs', canonicalUrl: 'https://jobs.acme.example/role/1', contentHash: hash, retrievedAt: NOW });
const engine = provider => new ContactIntelligenceEngine({ provider, clock: () => new Date(NOW) });

function addJob(registry, id, externalId) {
  registry.startRun({ id });
  const result = registry.recordObservation(id, {
    provider: 'fixture', externalId, sourceUrl: `https://jobs.acme.example/${externalId}`,
    title: 'Platform Engineer', company: 'Acme Labs', location: 'Remote', description: 'Build systems.', retrievedAt: NOW,
  });
  registry.finishRun(id);
  return result;
}

test('company and person models expose only evidence-backed public facts', async () => {
  const artifact = await engine(new FixtureContactProvider()).research({ job: job(), observation: observation() });
  assert.equal(artifact.company.name, 'Acme Labs');
  assert.equal(artifact.company.domain, 'acme.example');
  assert.equal(artifact.company.industry, 'AI infrastructure');
  assert.equal(artifact.company.careersUrl, 'https://acme.example/careers');
  assert.ok(artifact.company.evidence.every(item => item.source.sourceHash && item.source.providerId));
  assert.deepEqual(
    { name: artifact.people[0].name, role: artifact.people[0].role, status: artifact.people[0].status, confidence: artifact.people[0].confidence },
    { name: 'Jane Rivera', role: 'Technical Recruiter', status: 'CONFIRMED', confidence: 'HIGH' },
  );
});

test('a person without sufficient evidence remains UNKNOWN', async () => {
  const provider = new FixtureContactProvider({ people: [{ ref: 'unverified', name: 'Unverified Person', role: 'Recruiter', evidence: [] }] });
  const artifact = await engine(provider).research({ job: job(), observation: observation() });
  assert.equal(artifact.people[0].status, 'UNKNOWN');
  assert.equal(artifact.people[0].role, null);
  assert.deepEqual(
    { type: artifact.relationships[0].type, confidence: artifact.relationships[0].confidence, status: artifact.relationships[0].status },
    { type: 'UNKNOWN', confidence: 'LOW', status: 'UNKNOWN' },
  );
});

test('relationship confidence is high for an explicit recruiter and low for a generic company person', async () => {
  const provider = new FixtureContactProvider({ people: [
    { ref: 'recruiter', name: 'Alex Chen', role: 'Recruiter', evidence: [evidence('name', 'Alex Chen', 'HIGH', 'alex-name'), evidence('company', 'Acme Labs', 'HIGH', 'alex-company'), evidence('role', 'Recruiter', 'HIGH', 'alex-role')] },
    { ref: 'contact', name: 'Morgan Lee', role: 'Operations Specialist', evidence: [evidence('name', 'Morgan Lee', 'HIGH', 'morgan-name'), evidence('company', 'Acme Labs', 'HIGH', 'morgan-company'), evidence('role', 'Operations Specialist', 'MEDIUM', 'morgan-role')] },
  ] });
  const artifact = await engine(provider).research({ job: job(), observation: observation() });
  assert.deepEqual(artifact.relationships.map(item => [item.type, item.confidence]), [['RECRUITER', 'HIGH'], ['COMPANY_CONTACT', 'LOW']]);
});

test('engineering team membership is never promoted to hiring manager', async () => {
  const provider = new FixtureContactProvider({
    people: [{ ref: 'engineer', name: 'Sam Patel', role: 'Engineering team member', evidence: [evidence('name', 'Sam Patel', 'HIGH', 'sam-name'), evidence('company', 'Acme Labs', 'HIGH', 'sam-company'), evidence('role', 'Engineering team member', 'HIGH', 'sam-role')] }],
    relationships: [{ personRef: 'engineer', type: 'HIRING_MANAGER', evidence: [] }],
  });
  const artifact = await engine(provider).research({ job: job(), observation: observation() });
  assert.equal(artifact.relationships[0].type, 'TEAM_MEMBER');
  assert.equal(artifact.relationships[0].confidence, 'LOW');
});

test('same company from different jobs is consolidated in the registry', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  try {
    const firstJob = addJob(registry, 'run-company-1', 'company-1');
    const secondJob = addJob(registry, 'run-company-2', 'company-2');
    const provider = new FixtureContactProvider();
    registry.recordContactResearch(await engine(provider).research({ job: job(firstJob.jobId), observation: observation('job-1') }));
    registry.recordContactResearch(await engine(provider).research({ job: job(secondJob.jobId), observation: observation('job-2') }));
    assert.equal(registry.db.prepare('SELECT COUNT(*) count FROM companies').get().count, 1);
    assert.equal(registry.db.prepare('SELECT COUNT(*) count FROM job_companies').get().count, 2);
    assert.equal(registry.getLatestContactResearch(secondJob.jobId).companyResearchVersion, 2);
  } finally { registry.close(); }
});

test('same person from different source versions is consolidated and all evidence is preserved', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  try {
    const storedJob = addJob(registry, 'run-person', 'person-job');
    const first = new FixtureContactProvider();
    const second = new FixtureContactProvider({ people: [{ ref: 'jane-elsewhere', name: 'Jane Rivera', role: 'Technical Recruiter', evidence: [
      evidence('name', 'Jane Rivera', 'HIGH', 'jane-name-v2', 'PUBLIC_PROFILE'),
      evidence('company', 'Acme Labs', 'HIGH', 'jane-company-v2', 'PUBLIC_PROFILE'),
      evidence('role', 'Technical Recruiter', 'HIGH', 'jane-role-v2', 'PUBLIC_PROFILE'),
    ] }] });
    registry.recordContactResearch(await engine(first).research({ job: job(storedJob.jobId), observation: observation() }));
    registry.recordContactResearch(await engine(second).research({ job: job(storedJob.jobId), observation: observation() }));
    const companyId = registry.getLatestContactResearch(storedJob.jobId).companyId;
    const people = registry.getCompanyPeople(companyId);
    assert.equal(people.length, 1);
    assert.ok(people[0].evidence.length >= 7);
  } finally { registry.close(); }
});

test('source content change creates a new research version while exact reruns are idempotent', async () => {
  const registry = new JobRegistry({ dbPath: ':memory:', clock: () => new Date(NOW) });
  try {
    const storedJob = addJob(registry, 'run-version', 'version-job');
    const one = await engine(new FixtureContactProvider({ companyHash: 'company-v1' })).research({ job: job(storedJob.jobId), observation: observation() });
    const duplicate = await engine(new FixtureContactProvider({ companyHash: 'company-v1' })).research({ job: job(storedJob.jobId), observation: observation() });
    const two = await engine(new FixtureContactProvider({ companyHash: 'company-v2' })).research({ job: job(storedJob.jobId), observation: observation() });
    const firstStored = registry.recordContactResearch(one);
    const duplicateStored = registry.recordContactResearch(duplicate);
    const secondStored = registry.recordContactResearch(two);
    assert.equal(duplicateStored.id, firstStored.id);
    assert.equal(duplicateStored.existing, true);
    assert.notEqual(one.sourceHash, two.sourceHash);
    assert.equal(secondStored.contactResearchVersion, 2);
    assert.equal(secondStored.companyResearchVersion, 2);
  } finally { registry.close(); }
});

test('application-package integration is read-only context and the module has no external-action capability', async () => {
  const artifact = await engine(new FixtureContactProvider()).research({ job: job(), observation: observation() });
  const pkg = Object.freeze({ id: 'package-1', jobId: 'job-1', artifacts: Object.freeze({ untouched: true }) });
  const context = buildApplicationPackageContactContext(pkg, artifact);
  assert.equal(context.applicationPackageId, 'package-1');
  assert.deepEqual(pkg.artifacts, { untouched: true });
  for (const file of ['contracts.mjs', 'normalize.mjs', 'engine.mjs', 'integration.mjs']) {
    const code = readFileSync(new URL(`../contact-intelligence/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /better-sqlite3|JobRegistry|writeFile|appendFile|playwright|puppeteer|selenium/i);
    assert.doesNotMatch(code, /\b(?:send|message|email|connect|apply)\s*\(/i);
  }
});
