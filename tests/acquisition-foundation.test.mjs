import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContent } from '../acquisition/content-validation.mjs';
import { ACQUISITION_ERROR_CODES, CONTENT_STATUSES } from '../acquisition/contracts.mjs';

test('acquisition vocabulary includes semantic failures used by providers and page readers', () => {
  for (const code of ['AUTH_REQUIRED', 'RATE_LIMITED', 'BLOCKED', 'CAPTCHA', 'EMPTY_CONTENT', 'CHALLENGE', 'NOT_JOB_CONTENT', 'NOT_FOUND', 'SCHEMA_CHANGED', 'TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'POLICY_DENIED']) {
    assert.ok(ACQUISITION_ERROR_CODES.includes(code));
  }
  assert.ok(CONTENT_STATUSES.includes('VALID'));
  assert.ok(CONTENT_STATUSES.includes('LOGIN_REQUIRED'));
  assert.ok(CONTENT_STATUSES.includes('NOT_JOB_CONTENT'));
});

test('HTTP 200 empty or challenge content is not treated as content success', () => {
  assert.equal(validateContent({ httpStatus: 200, text: '' }).status, 'EMPTY_CONTENT');
  assert.equal(validateContent({ httpStatus: 200, text: 'Just a moment... checking your browser' }).status, 'CHALLENGE');
  assert.equal(validateContent({ httpStatus: 200, text: 'Please complete this CAPTCHA' }).status, 'CAPTCHA');
  assert.equal(validateContent({ httpStatus: 200, text: 'Real job title and description', schemaValid: false }).status, 'SCHEMA_CHANGED');
  assert.equal(validateContent({ httpStatus: 200, text: 'Real job title and description', schemaValid: true }).status, 'VALID');
});
