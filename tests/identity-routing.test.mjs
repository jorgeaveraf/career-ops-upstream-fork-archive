import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { inspectIdentityRouting, loadIdentityRouting, resolveIdentityForPurpose, validateIdentityRouting } from '../operations/identity-routing.mjs';

const routing = {
  version: 1,
  source: 'USER_CONFIRMED',
  candidate_email: 'candidate@example.com',
  google_workspace_gcp: { identity: 'Workspace', principal: 'operator@workspace.example', purposes: ['GOOGLE_SHEETS', 'GCP', 'COMMAND_GATEWAY_GCP', 'PUBSUB_PUBLISH', 'PUBSUB_SUBSCRIBE'] },
  browser_job_search: { chrome_profile: 'Candidate', purposes: ['ATS', 'LINKEDIN', 'APPLICATION_SUBMISSION'] },
  application_email: { sender: 'candidate@example.com', purposes: ['CV_APPLICATION_EMAIL', 'APPLICATION_CORRESPONDENCE'] },
  platform_signup: { account_email: 'signup@example.com', purposes: ['REQUIRED_JOB_PLATFORM_ACCOUNT_CREATION'], prohibited_uses: ['APPLICATION_SENDER', 'CONTACT_SENDER'], exception_policy: 'EXPLICIT_USER_AUTHORIZATION_REQUIRED' },
};

test('identity routing resolves each purpose to its isolated identity', () => {
  assert.deepEqual(resolveIdentityForPurpose(routing, 'GOOGLE_SHEETS'), { channel: 'GOOGLE_WORKSPACE_GCP', identity: 'Workspace', principal: 'operator@workspace.example' });
  assert.deepEqual(resolveIdentityForPurpose(routing, 'PUBSUB_SUBSCRIBE'), { channel: 'GOOGLE_WORKSPACE_GCP', identity: 'Workspace', principal: 'operator@workspace.example' });
  assert.deepEqual(resolveIdentityForPurpose(routing, 'ATS'), { channel: 'BROWSER_JOB_SEARCH', chromeProfile: 'Candidate' });
  assert.deepEqual(resolveIdentityForPurpose(routing, 'CV_APPLICATION_EMAIL'), { channel: 'APPLICATION_EMAIL', sender: 'candidate@example.com' });
  assert.deepEqual(resolveIdentityForPurpose(routing, 'REQUIRED_JOB_PLATFORM_ACCOUNT_CREATION'), { channel: 'PLATFORM_SIGNUP', accountEmail: 'signup@example.com' });
  assert.deepEqual(resolveIdentityForPurpose(routing, 'APPLICATION_SENDER'), { channel: 'DENIED', reason: 'EXPLICIT_USER_AUTHORIZATION_REQUIRED', accountEmail: 'signup@example.com' });
});

test('identity routing rejects Workspace, browser, and sender drift', () => {
  const result = validateIdentityRouting(routing, { env: { GOOGLE_IMPERSONATION_SUBJECT: 'wrong@workspace.example', BROWSER_PROFILE: 'Wrong', APPLICATION_BROWSER_PROFILE: 'Candidate' } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.code === 'WORKSPACE_PRINCIPAL_ENV_MISMATCH'));
  assert.ok(result.errors.some(item => item.code === 'BROWSER_PROFILE_MISMATCH'));
  assert.equal(validateIdentityRouting({ ...routing, application_email: { ...routing.application_email, sender: 'other@example.com' } }, { env: {} }).ok, false);
});

test('candidate sender can never drift to Workspace notification or signup identities',()=>{for(const sender of ['career@brunova.mx','fubifo@gmail.com']){const result=validateIdentityRouting({...routing,application_email:{...routing.application_email,sender}},{env:{}});assert.equal(result.ok,false);assert.ok(result.errors.some(item=>item.code==='APPLICATION_SENDER_CANDIDATE_MISMATCH'));}const workspaceCandidate=validateIdentityRouting({...routing,google_workspace_gcp:{...routing.google_workspace_gcp,principal:'candidate@example.com'}},{env:{}});assert.equal(workspaceCandidate.ok,false);assert.ok(workspaceCandidate.errors.some(item=>item.code==='WORKSPACE_CANDIDATE_IDENTITY_COLLISION'));});

test('profile-backed routing loads and missing routing remains optional', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-identity-routing-'));
  const configured = path.join(root, 'configured.yml');
  writeFileSync(configured, `candidate:\n  email: candidate@example.com\nidentity_routing:\n  version: 1\n  google_workspace_gcp:\n    identity: Workspace\n    principal: operator@workspace.example\n    purposes: [GOOGLE_SHEETS]\n  browser_job_search:\n    chrome_profile: Candidate\n    purposes: [ATS]\n  application_email:\n    sender: candidate@example.com\n    purposes: [CV_APPLICATION_EMAIL]\n  platform_signup:\n    account_email: signup@example.com\n    purposes: [REQUIRED_JOB_PLATFORM_ACCOUNT_CREATION]\n    prohibited_uses: [APPLICATION_SENDER, CONTACT_SENDER]\n    exception_policy: EXPLICIT_USER_AUTHORIZATION_REQUIRED\n`);
  assert.equal(loadIdentityRouting({ profilePath: configured }).candidate_email, 'candidate@example.com');
  assert.equal(inspectIdentityRouting({ profilePath: configured, env: { BROWSER_PROFILE: 'candidate' } }).ok, true);
  const absent = path.join(root, 'absent.yml'); mkdirSync(path.dirname(absent), { recursive: true }); writeFileSync(absent, 'candidate:\n  email: candidate@example.com\n');
  assert.deepEqual(inspectIdentityRouting({ profilePath: absent, env: {} }), { ok: true, configured: false, errors: [], routes: {} });
});
