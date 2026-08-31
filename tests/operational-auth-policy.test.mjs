import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { GoogleSheetsApiAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { TAB_CONTRACTS } from '../human-control-plane/contracts.mjs';
import {
  GoogleIamRemoteSigningTokenProvider, GoogleOAuthTokenProvider, WorkspaceBrokerTokenProvider, inspectGoogleOAuthConfig, loadApplicationDefaultCredentials,
} from '../operations/google-oauth.mjs';
import { validateOperationalConfig } from '../operations/config-validation.mjs';
import { assertResearchActionAllowed, browserPolicySummary } from '../research/browser-policy.mjs';
import { BrowserSessionManager, selectChromeProfile } from '../research/browser-session-manager.mjs';
import { googleAuthorizeArgs } from '../google-auth.mjs';

const NOW = '2026-08-23T18:00:00.000Z';

function adcFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-oauth-'));
  const credentialsPath = path.join(root, 'adc.json');
  writeFileSync(credentialsPath, JSON.stringify({
    type: 'authorized_user', client_id: 'client-id', client_secret: 'client-secret', refresh_token: 'refresh-token',
  }), { mode: 0o600 });
  return { root, credentialsPath, env: { GOOGLE_SHEETS_AUTH_MODE: 'application_default', GOOGLE_APPLICATION_CREDENTIALS: credentialsPath } };
}

function chromeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'career-ops-profile-'));
  mkdirSync(path.join(root, 'Default'));
  writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Jorge' }, 'Profile 2': { name: 'HQ' } } } }));
  return root;
}

test('OAuth configuration accepts complete ADC and reports missing configuration or credentials', () => {
  const fixture = adcFixture();
  assert.equal(inspectGoogleOAuthConfig({ env: fixture.env }).ok, true);
  assert.equal(loadApplicationDefaultCredentials({ env: fixture.env }).refresh_token, 'refresh-token');
  assert.equal(inspectGoogleOAuthConfig({ env: {} }).code, 'GOOGLE_AUTH_MODE_MISSING');
  assert.equal(inspectGoogleOAuthConfig({ env: { GOOGLE_SHEETS_AUTH_MODE: 'oauth_env' } }).code, 'GOOGLE_OAUTH_CREDENTIALS_MISSING');
  const absent = inspectGoogleOAuthConfig({ env: { GOOGLE_SHEETS_AUTH_MODE: 'application_default', GOOGLE_APPLICATION_CREDENTIALS: path.join(fixture.root, 'absent.json') } });
  assert.equal(absent.code, 'GOOGLE_ADC_MISSING');
});

test('manual access tokens are rejected as persistent configuration', () => {
  const fixture = adcFixture();
  const result = inspectGoogleOAuthConfig({ env: { ...fixture.env, GOOGLE_SHEETS_ACCESS_TOKEN: 'temporary-token' } });
  assert.equal(result.ok, false); assert.equal(result.code, 'GOOGLE_STATIC_TOKEN_FORBIDDEN');
});

test('authorization uses the configured private Desktop OAuth client', () => {
  const args = googleAuthorizeArgs({ env: { GOOGLE_OAUTH_CLIENT_FILE: 'config/google-oauth-client.json' } });
  assert.ok(args.includes('--client-id-file=config/google-oauth-client.json'));
  assert.ok(args.some(value => value.includes('auth/spreadsheets')));
  assert.equal(googleAuthorizeArgs({ env: {} }).some(value => value.startsWith('--client-id-file=')), false);
});

test('refresh token produces a cached in-memory access token and Sheets consumes it', async () => {
  const requests = []; let refreshes = 0;
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('oauth2.googleapis.com')) {
      refreshes++; return { ok: true, status: 200, json: async () => ({ access_token: 'ephemeral-access', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({ spreadsheetId: 'sheet-fixture' }) };
  };
  const provider = new GoogleOAuthTokenProvider({
    credentials: { client_id: 'client-id', client_secret: 'client-secret', refresh_token: 'refresh-token' },
    fetchImpl, clock: () => new Date(NOW),
  });
  const adapter = new GoogleSheetsApiAdapter({ spreadsheetId: 'sheet-fixture', tokenProvider: provider, fetchImpl });
  await adapter.request(`${adapter.base}?fields=spreadsheetId`);
  await adapter.request(`${adapter.base}?fields=spreadsheetId`);
  assert.equal(refreshes, 1);
  const sheetRequests = requests.filter(item => item.url.includes('sheets.googleapis.com'));
  assert.equal(sheetRequests.length, 2);
  assert.ok(sheetRequests.every(item => item.options.headers.Authorization === 'Bearer ephemeral-access'));
  assert.equal(JSON.stringify(provider).includes('ephemeral-access'), false, 'token cache must not be JSON-persistable');
});

test('IAM remote signer creates and caches a delegated Workspace token without a private key', async () => {
  const requests=[];let sourceRefreshes=0;let signs=0;let exchanges=0;
  const fetchImpl=async(url,options={})=>{requests.push({url:String(url),options});if(String(url).includes('iamcredentials.googleapis.com')){signs++;return{ok:true,status:200,json:async()=>({signedBlob:Buffer.from('signature').toString('base64')})};}if(String(url).includes('oauth2.googleapis.com')){exchanges++;return{ok:true,status:200,json:async()=>({access_token:'delegated-token',expires_in:3600})};}throw new Error(`unexpected ${url}`);};
  const sourceTokenProvider={getAccessToken:async()=>{sourceRefreshes++;return'source-token';},clear(){}};
  const provider=new GoogleIamRemoteSigningTokenProvider({sourceTokenProvider,serviceAccountEmail:'agent@example-project.iam.gserviceaccount.com',subject:'user@example.com',scopes:['https://www.googleapis.com/auth/spreadsheets'],fetchImpl,clock:()=>new Date(NOW)});
  assert.equal(await provider.getAccessToken(),'delegated-token');assert.equal(await provider.getAccessToken(),'delegated-token');
  assert.equal(sourceRefreshes,1);assert.equal(signs,1);assert.equal(exchanges,1);
  const sign=requests.find(item=>item.url.includes('iamcredentials.googleapis.com'));assert.equal(sign.options.headers.Authorization,'Bearer source-token');assert.ok(JSON.parse(sign.options.body).payload);
  assert.equal(JSON.stringify(provider).includes('delegated-token'),false);
});

test('IAM remote signing is the configured machine provider and broken unused fallback is ignored', () => {
  const fixture=adcFixture();const env={...fixture.env,GOOGLE_SHEETS_AUTH_MODE:'iam_remote_signing',GOOGLE_REMOTE_SIGNER_SERVICE_ACCOUNT:'agent@example-project.iam.gserviceaccount.com',GOOGLE_IMPERSONATION_SUBJECT:'user@example.com'};
  const inspection=inspectGoogleOAuthConfig({env});assert.equal(inspection.ok,true);assert.equal(inspection.mode,'iam_remote_signing');assert.equal(inspection.credentialSource,'application_default_iam_remote_signing');
  assert.equal(inspectGoogleOAuthConfig({env:{...env,GOOGLE_REMOTE_SIGNER_SERVICE_ACCOUNT:''}}).code,'GOOGLE_REMOTE_SIGNER_MISSING');
});

test('Workspace broker pins principal and subject and forces a fresh server token',async()=>{const requests=[];const provider=new WorkspaceBrokerTokenProvider({url:'https://broker.example',secret:'secret',expectedPrincipal:'agent@project.iam.gserviceaccount.com',expectedSubject:'brunova@brunova.mx',clock:()=>new Date(NOW),fetchImpl:async(url,options)=>{requests.push({url,options});return{ok:true,status:200,json:async()=>({access_token:`token-${requests.length}`,expires_in:3600,principal:'agent@project.iam.gserviceaccount.com',subject:'brunova@brunova.mx'})};}});assert.equal(await provider.getAccessToken(),'token-1');assert.equal(await provider.getAccessToken(),'token-1');assert.equal(await provider.getAccessToken({forceRefresh:true}),'token-2');assert.equal(requests.length,2);assert.equal(JSON.stringify(provider).includes('token-2'),false);});

test('production config fails closed on user ADC and command provider drift',()=>{const root=mkdtempSync(path.join(os.tmpdir(),'career-prod-pin-'));for(const file of ['cv.md','portals.yml','candidate/manifest.yml']){mkdirSync(path.dirname(path.join(root,file)),{recursive:true});writeFileSync(path.join(root,file),'x');}mkdirSync(path.join(root,'config'),{recursive:true});writeFileSync(path.join(root,'config/profile.yml'),'x');const fixture=adcFixture(),result=validateOperationalConfig({projectRoot:root,requireDatabase:false,env:{...fixture.env,CAREER_OPS_PRODUCTION:'true',CAREER_OPS_SHEET_ID:'sheet',CAREER_OPS_COMMAND_SUBSCRIBER_PROVIDER:'direct_adc'}});assert.equal(result.ok,false);assert.ok(result.errors.some(x=>x.code==='PRODUCTION_WORKSPACE_PROVIDER_DRIFT'));assert.ok(result.errors.some(x=>x.code==='PRODUCTION_COMMAND_PROVIDER_DRIFT'));});

test('Sheets diff writes use quoted bounded A1 ranges in one values batch', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const adapter = new GoogleSheetsApiAdapter({
    spreadsheetId: 'sheet-fixture',
    tokenProvider: { getAccessToken: async () => 'ephemeral-access' },
    fetchImpl,
  });
  await adapter.writeTab('SETTINGS', [['Status']]);
  const update = requests.find(item => item.url.endsWith('/values:batchUpdate'));
  assert.ok(update);
  const body = JSON.parse(update.options.body);
  assert.equal(body.valueInputOption,'USER_ENTERED');
  assert.deepEqual(body.data,[{range:"'SETTINGS'!A1:A1",majorDimension:'ROWS',values:[['Status']]}]);
});

test('research_only permits research intents and blocks external actions', () => {
  for (const action of ['navigate', 'search', 'read', 'filter', 'scroll', 'open_result', 'extract_evidence']) assert.equal(assertResearchActionAllowed(action), action);
  for (const action of ['apply', 'send', 'message', 'connect', 'submit', 'modify_profile']) {
    assert.throws(() => assertResearchActionAllowed(action), error => error.code === 'BROWSER_ACTION_DENIED');
  }
  const policy = browserPolicySummary();
  assert.equal(policy.mode, 'research_only'); assert.ok(policy.blocked.includes('apply')); assert.ok(policy.blocked.includes('message'));
});

test('Chrome profile validation covers existing and missing Jorge profile while Chrome locks remain informational', () => {
  const root = chromeFixture();
  const selection = selectChromeProfile({ profile: 'jorge', mode: 'research_only', userDataDir: root });
  assert.equal(selection.profileDirectory, 'Default');
  assert.throws(() => selectChromeProfile({ profile: 'jorge', mode: 'research_only', userDataDir: path.join(root, 'missing') }), error => error.code === 'BROWSER_PROFILE_UNAVAILABLE');
  writeFileSync(path.join(root, 'SingletonLock'), 'occupied');
  const manager = new BrowserSessionManager({ lockPath: path.join(root, 'career-ops.lock') });
  assert.equal(manager.inspect(selection).code, 'AVAILABLE');
  assert.equal(manager.inspect(selection).userChromeOpen, true);
  const session = manager.acquire(selection); assert.equal(session.profile, 'jorge'); manager.release(session);
});
