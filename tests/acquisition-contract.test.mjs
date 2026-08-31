import test from 'node:test';
import assert from 'node:assert/strict';
import greenhouse from '../providers/greenhouse.mjs';
import {
  acquireProvider,
  classifyAcquisitionError,
  throwForAcquisitionFailure,
  toNormalizedObservation,
} from '../acquisition/provider-adapter.mjs';
import { DirectPageReader, JinaPageReader } from '../acquisition/page-reader.mjs';
import { enrichJobFromPublicWeb, PublicWebReader, publicWebFallbackConfig } from '../acquisition/public-web-fallback.mjs';
import { validateContent } from '../acquisition/content-validation.mjs';
import { loadProviders } from '../providers/_registry.mjs';
import { fileURLToPath } from 'url';

const NOW = '2026-08-22T08:00:00.000Z';
const VALID_JOB = 'Senior AI Engineer\nResponsibilities include building reliable AI systems. Requirements include JavaScript and SQL. Apply now.';

test('every core provider loaded by the scanner exposes the common acquire contract', async () => {
  const providers = await loadProviders(fileURLToPath(new URL('../providers', import.meta.url)));
  assert.ok(providers.size > 20);
  for (const provider of providers.values()) assert.equal(typeof provider.acquire, 'function', provider.id);
});

test('provider acquisition contract preserves identity, provenance, evidence, and metadata', async () => {
  const result = await acquireProvider(
    greenhouse,
    { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
    { fetchJson: async () => ({ jobs: [{
      id: 123,
      title: 'Senior AI Engineer',
      absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/123?utm_source=test',
      location: { name: 'Mexico' },
      first_published: '2026-08-20T10:00:00Z',
    }] }) },
    { runId: 'run-contract', retrievedAt: NOW },
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 1);
  const job = result.data[0];
  assert.equal(job.externalId, '123');
  assert.equal(job.sourceUrl, 'https://job-boards.greenhouse.io/acme/jobs/123?utm_source=test');
  assert.equal(job.canonicalUrl, 'https://job-boards.greenhouse.io/acme/jobs/123');
  assert.equal(job.providerVersion, '1');
  assert.deepEqual(
    { providerId: job.provenance.providerId, runId: job.provenance.runId, retrievedAt: job.provenance.retrievedAt },
    { providerId: 'greenhouse', runId: 'run-contract', retrievedAt: NOW },
  );
  assert.equal(job.evidence.find(item => item.field === 'title').confidence, 'high');
  assert.equal(job.evidence.find(item => item.field === 'title').extractionMethod, 'direct');
  assert.equal(job.evidence.find(item => item.field === 'canonicalUrl').extractionMethod, 'normalized');
  assert.equal(job.rawMetadata.acquisitionContractVersion, 1);

  const observation = toNormalizedObservation(job, { providerId: 'greenhouse-api', trackedTarget: 'Acme' });
  assert.equal(observation.provider, 'greenhouse-api');
  assert.equal(observation.rawMetadata.provenance.providerId, 'greenhouse');
  assert.ok(observation.evidence.some(item => item.field === 'canonicalUrl'));
});

test('provider failures are semantic AcquisitionResults and can be thrown compatibly', async () => {
  const timeout = new Error('request timed out');
  timeout.name = 'AbortError';
  const provider = { id: 'fixture', fetch: async () => { throw timeout; } };
  const result = await acquireProvider(provider, {}, {}, { retrievedAt: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(
    { code: result.error.code, providerId: result.error.providerId, retryable: result.error.retryable },
    { code: 'TIMEOUT', providerId: 'fixture', retryable: true },
  );
  assert.throws(() => throwForAcquisitionFailure(result), error => error.acquisitionCode === 'TIMEOUT');
  assert.equal(classifyAcquisitionError({ status: 429, message: 'rate limited', retryAfter: '2' }, 'fixture').retryAfterMs, 2000);

  const schema = await acquireProvider(
    greenhouse,
    { name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' },
    { fetchJson: async () => ({ unexpected: true }) },
    { retrievedAt: NOW },
  );
  assert.equal(schema.error.code, 'SCHEMA_CHANGED');
});

test('content validation distinguishes login, not-job, challenge, empty, and valid content', () => {
  assert.equal(validateContent({ httpStatus: 401, text: '' }).status, 'LOGIN_REQUIRED');
  assert.equal(validateContent({ httpStatus: 200, text: 'This position is no longer available', expectedJob: true }).status, 'NOT_JOB_CONTENT');
  assert.equal(validateContent({ httpStatus: 200, text: 'Just a moment... checking your browser', expectedJob: true }).status, 'CHALLENGE');
  assert.equal(validateContent({ httpStatus: 200, text: '', expectedJob: true }).status, 'EMPTY_CONTENT');
  assert.equal(validateContent({ httpStatus: 200, text: VALID_JOB, expectedJob: true }).status, 'VALID');
});

test('DirectPageReader classifies valid, challenge, empty, and timeout responses', async () => {
  const reader = new DirectPageReader({ clock: () => new Date(NOW) });
  const valid = await reader.read('https://jobs.example.com/123', { fetchText: async () => VALID_JOB });
  assert.equal(valid.ok, true);
  assert.equal(valid.data.status, 'VALID');
  assert.ok(valid.data.contentHash);

  const challenge = await reader.read('https://jobs.example.com/123', { fetchText: async () => 'Please complete this CAPTCHA' });
  assert.equal(challenge.ok, false);
  assert.equal(challenge.error.code, 'CAPTCHA');
  assert.equal(challenge.data.status, 'CAPTCHA');

  const empty = await reader.read('https://jobs.example.com/123', { fetchText: async () => '' });
  assert.equal(empty.error.code, 'EMPTY_CONTENT');

  const timeout = await reader.read('https://jobs.example.com/123', {
    fetchText: async () => { const error = new Error('timed out'); error.name = 'AbortError'; throw error; },
  });
  assert.equal(timeout.error.code, 'TIMEOUT');
  assert.equal(timeout.error.retryable, true);
});

test('Jina is an optional second attempt after invalid direct content', async () => {
  const requested = [];
  const context = {
    fetchText: async url => {
      requested.push(url);
      if (url.startsWith('https://r.jina.ai/')) return VALID_JOB;
      const error = new Error('HTTP 403 Forbidden');
      error.status = 403;
      throw error;
    },
  };
  const reader = new PublicWebReader({
    enableJina: true,
    directReader: new DirectPageReader({ clock: () => new Date(NOW) }),
    jinaReader: new JinaPageReader({ clock: () => new Date(NOW) }),
  });
  const result = await reader.read('https://jobs.example.com/123', context);
  assert.equal(result.ok, true);
  assert.equal(result.data.readerId, 'jina-reader');
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(requested, [
    'https://jobs.example.com/123',
    'https://r.jina.ai/https://jobs.example.com/123',
  ]);
  assert.match(result.warnings[0], /direct-http failed: BLOCKED/);
});

test('Jina is not called when disabled or when direct content is valid', async () => {
  let calls = 0;
  const context = { fetchText: async () => { calls++; return VALID_JOB; } };
  const disabled = new PublicWebReader({ enableJina: false });
  assert.equal((await disabled.read('https://jobs.example.com/1', context)).data.readerId, 'direct-http');
  const enabled = new PublicWebReader({ enableJina: true });
  assert.equal((await enabled.read('https://jobs.example.com/2', context)).data.readerId, 'direct-http');
  assert.equal(calls, 2);
});

test('successful page enrichment preserves reader provenance on the provider job', async () => {
  const reader = new PublicWebReader({ enableJina: false, directReader: new DirectPageReader({ clock: () => new Date(NOW) }) });
  const enrichment = await enrichJobFromPublicWeb(
    { title: 'AI Engineer', url: 'https://jobs.example.com/3', rawMetadata: { feed: 'fixture' } },
    reader,
    { fetchText: async () => VALID_JOB },
  );
  assert.equal(enrichment.result.ok, true);
  assert.equal(enrichment.job.description, VALID_JOB);
  assert.ok(enrichment.job.contentHash);
  assert.equal(enrichment.job.rawMetadata.feed, 'fixture');
  assert.equal(enrichment.job.rawMetadata.descriptionProvenance.providerId, 'direct-http');
});

test('public web fallback is explicit, bounded, and rejects local targets', async () => {
  assert.deepEqual(publicWebFallbackConfig({}), { enabled: false, jina: false, maxPagesPerTarget: 0 });
  assert.deepEqual(publicWebFallbackConfig({ acquisition: { public_web_fallback: { enabled: true, jina: true, max_pages_per_target: 100 } } }), {
    enabled: true, jina: true, maxPagesPerTarget: 5,
  });
  const result = await new DirectPageReader().read('http://127.0.0.1/private', { fetchText: async () => VALID_JOB });
  assert.equal(result.ok, false);
  assert.match(result.error.safeMessage, /public web/);
});
