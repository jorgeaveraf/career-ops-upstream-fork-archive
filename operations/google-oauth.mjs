import { existsSync, readFileSync } from 'fs';
import { createHmac, createSign, randomUUID } from 'crypto';
import os from 'os';
import path from 'path';

export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const GOOGLE_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_SHEETS_AUTH_MODES = Object.freeze(['workspace_broker', 'iam_remote_signing', 'service_account_impersonation', 'application_default', 'oauth_env']);

export class GoogleOAuthError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'GoogleOAuthError'; this.code = code; this.details = details;
  }
}

export function defaultApplicationCredentialsPath(env = process.env) {
  return path.resolve(env.GOOGLE_APPLICATION_CREDENTIALS || path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'));
}

function requiredAuthorizedUserFields(credentials) {
  return ['client_id', 'client_secret', 'refresh_token'].filter(name => !String(credentials?.[name] || '').trim());
}

const base64url = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const configuredScopes = env => String(env.GOOGLE_SHEETS_SCOPES || GOOGLE_SHEETS_SCOPE).split(/[ ,]+/).map(value => value.trim()).filter(Boolean);
const remoteSignerEmail = env => String(env.GOOGLE_REMOTE_SIGNER_SERVICE_ACCOUNT || env.GOOGLE_MACHINE_SERVICE_ACCOUNT_EMAIL || '').trim();

export function loadIamRemoteSigningConfig({ env = process.env } = {}) {
  const serviceAccountEmail = remoteSignerEmail(env);
  if (!serviceAccountEmail.endsWith('.iam.gserviceaccount.com')) throw new GoogleOAuthError('GOOGLE_REMOTE_SIGNER_MISSING', 'GOOGLE_REMOTE_SIGNER_SERVICE_ACCOUNT is required');
  const subject = String(env.GOOGLE_IMPERSONATION_SUBJECT || '').trim();
  if (!subject) throw new GoogleOAuthError('GOOGLE_IMPERSONATION_SUBJECT_MISSING', 'GOOGLE_IMPERSONATION_SUBJECT is required');
  const sourceCredentialsPath = defaultApplicationCredentialsPath(env);
  const sourceCredentials = loadApplicationDefaultCredentials({ env, credentialsPath: sourceCredentialsPath });
  return { serviceAccountEmail, subject, scopes: configuredScopes(env), sourceCredentials, sourceCredentialsPath };
}
export function loadMachineCredentials({ env = process.env } = {}) {
  const credentialsPath = path.resolve(String(env.GOOGLE_MACHINE_CREDENTIALS_FILE || env.GOOGLE_APPLICATION_CREDENTIALS || ''));
  if (!String(env.GOOGLE_MACHINE_CREDENTIALS_FILE || env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()) throw new GoogleOAuthError('GOOGLE_MACHINE_CREDENTIALS_MISSING', 'GOOGLE_MACHINE_CREDENTIALS_FILE is required');
  if (!existsSync(credentialsPath)) throw new GoogleOAuthError('GOOGLE_MACHINE_CREDENTIALS_MISSING', `Machine credentials not found: ${credentialsPath}`);
  let credentials; try { credentials = JSON.parse(readFileSync(credentialsPath, 'utf8')); } catch (error) { throw new GoogleOAuthError('GOOGLE_MACHINE_CREDENTIALS_INVALID', `Cannot read machine credentials: ${error.message}`); }
  if (credentials.type !== 'service_account') throw new GoogleOAuthError('GOOGLE_MACHINE_CREDENTIALS_UNSUPPORTED', 'Machine credentials must be a service_account JSON');
  const missing = ['client_email','private_key'].filter(name => !String(credentials[name] || '').trim());
  if (missing.length) throw new GoogleOAuthError('GOOGLE_MACHINE_CREDENTIALS_INCOMPLETE', `Machine credentials missing: ${missing.join(', ')}`);
  const subject = String(env.GOOGLE_IMPERSONATION_SUBJECT || '').trim();
  if (!subject) throw new GoogleOAuthError('GOOGLE_IMPERSONATION_SUBJECT_MISSING', 'GOOGLE_IMPERSONATION_SUBJECT is required');
  return { credentials, credentialsPath, subject, scopes: configuredScopes(env) };
}

export function loadApplicationDefaultCredentials({ env = process.env, credentialsPath = defaultApplicationCredentialsPath(env) } = {}) {
  if (!existsSync(credentialsPath)) throw new GoogleOAuthError('GOOGLE_ADC_MISSING', `Application Default Credentials not found: ${credentialsPath}`);
  let credentials;
  try { credentials = JSON.parse(readFileSync(credentialsPath, 'utf8')); }
  catch (error) { throw new GoogleOAuthError('GOOGLE_ADC_INVALID', `Cannot read Application Default Credentials: ${error.message}`); }
  if (!['authorized_user','impersonated_service_account'].includes(credentials.type)) throw new GoogleOAuthError('GOOGLE_ADC_UNSUPPORTED', 'Google Sheets requires authorized_user or impersonated_service_account Application Default Credentials');
  if(credentials.type==='authorized_user'){const missing=requiredAuthorizedUserFields(credentials);if(missing.length)throw new GoogleOAuthError('GOOGLE_ADC_INCOMPLETE',`Application Default Credentials missing: ${missing.join(', ')}`);}
  if(credentials.type==='impersonated_service_account'){const missing=requiredAuthorizedUserFields(credentials.source_credentials);if(!String(credentials.service_account_impersonation_url||'').trim())missing.push('service_account_impersonation_url');if(missing.length)throw new GoogleOAuthError('GOOGLE_ADC_INCOMPLETE',`Impersonated Application Default Credentials missing: ${missing.join(', ')}`);}
  return credentials;
}

export function inspectGoogleOAuthConfig({ env = process.env } = {}) {
  const mode = String(env.GOOGLE_SHEETS_AUTH_MODE || '').trim().toLowerCase();
  if (!mode) return { ok: false, mode: null, code: 'GOOGLE_AUTH_MODE_MISSING', detail: 'GOOGLE_SHEETS_AUTH_MODE is required' };
  if (!GOOGLE_SHEETS_AUTH_MODES.includes(mode)) return { ok: false, mode, code: 'GOOGLE_AUTH_MODE_UNSUPPORTED', detail: `Unsupported Google Sheets auth mode: ${mode}` };
  if (String(env.GOOGLE_SHEETS_ACCESS_TOKEN || '').trim()) {
    return { ok: false, mode, code: 'GOOGLE_STATIC_TOKEN_FORBIDDEN', detail: 'GOOGLE_SHEETS_ACCESS_TOKEN must not be persisted; use renewable OAuth' };
  }
  if (mode === 'workspace_broker') {
    const missing=['CAREER_OPS_WORKSPACE_BROKER_URL','CAREER_OPS_WORKSPACE_BROKER_SECRET','GOOGLE_REMOTE_SIGNER_SERVICE_ACCOUNT','GOOGLE_IMPERSONATION_SUBJECT'].filter(name=>!String(env[name]||'').trim());
    if(missing.length)return{ok:false,mode,code:'WORKSPACE_BROKER_CONFIG_MISSING',detail:`Missing Workspace broker configuration: ${missing.join(', ')}`,missing};
    const principal=remoteSignerEmail(env),subject=String(env.GOOGLE_IMPERSONATION_SUBJECT).trim();
    if(!principal.endsWith('.iam.gserviceaccount.com'))return{ok:false,mode,code:'WORKSPACE_PRINCIPAL_INVALID',detail:'GOOGLE_REMOTE_SIGNER_SERVICE_ACCOUNT must be a service account'};
    return{ok:true,mode,credentialSource:'cloud_run_iam_remote_signing_dwd',principal,subject,scopes:configuredScopes(env),interactiveDependency:false};
  }
  if (mode === 'iam_remote_signing') {
    try { const remote = loadIamRemoteSigningConfig({ env }); return { ok: true, mode, credentialSource: 'application_default_iam_remote_signing', credentialsPath: remote.sourceCredentialsPath, principal: remote.serviceAccountEmail, subject: remote.subject, scopes: remote.scopes }; }
    catch (error) { return { ok: false, mode, code: error.code || 'GOOGLE_REMOTE_SIGNER_INVALID', detail: error.message }; }
  }
  if (mode === 'service_account_impersonation') {
    try { const machine = loadMachineCredentials({ env }); return { ok: true, mode, credentialSource: 'service_account_json', credentialsPath: machine.credentialsPath, principal: machine.credentials.client_email, subject: machine.subject, scopes: machine.scopes }; }
    catch (error) { return { ok: false, mode, code: error.code || 'GOOGLE_MACHINE_CREDENTIALS_INVALID', detail: error.message }; }
  }
  if (mode === 'application_default') {
    const credentialsPath = defaultApplicationCredentialsPath(env);
    try {
      loadApplicationDefaultCredentials({ env, credentialsPath });
      return { ok: true, mode, credentialSource: 'application_default', credentialsPath };
    } catch (error) {
      return { ok: false, mode, code: error.code || 'GOOGLE_ADC_INVALID', detail: error.message, credentialsPath };
    }
  }
  const missing = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN']
    .filter(name => !String(env[name] || '').trim());
  return missing.length
    ? { ok: false, mode, code: 'GOOGLE_OAUTH_CREDENTIALS_MISSING', detail: `Missing renewable OAuth configuration: ${missing.join(', ')}`, missing }
    : { ok: true, mode, credentialSource: 'environment' };
}

export class WorkspaceBrokerTokenProvider {
  constructor({url,secret,expectedPrincipal,expectedSubject,fetchImpl=globalThis.fetch,clock=()=>new Date(),expirySkewSeconds=60}={}){
    if(!url||!secret||!expectedPrincipal||!expectedSubject)throw new GoogleOAuthError('WORKSPACE_BROKER_CONFIG_MISSING','Workspace broker URL, secret, principal, and subject are required');
    this.url=String(url).replace(/\/$/,'');this.secret=secret;this.expectedPrincipal=expectedPrincipal;this.expectedSubject=expectedSubject;this.fetch=fetchImpl;this.clock=clock;this.expirySkewMs=expirySkewSeconds*1000;this.cached=null;
  }
  async getAccessToken({forceRefresh=false}={}){
    const now=this.clock().getTime();if(!forceRefresh&&this.cached&&now+this.expirySkewMs<this.cached.expiresAt)return this.cached.value;
    const timestamp=this.clock().toISOString(),requestId=randomUUID(),signature=createHmac('sha256',this.secret).update(`${timestamp}\n${requestId}\nPOST\n/v1/workspace-token`).digest('base64url');
    let response;try{response=await this.fetch(`${this.url}/v1/workspace-token`,{method:'POST',headers:{'x-career-ops-request-id':requestId,'x-career-ops-timestamp':timestamp,'x-career-ops-signature':signature},signal:AbortSignal.timeout(15000)});}catch(cause){throw new GoogleOAuthError('WORKSPACE_BROKER_UNAVAILABLE',`Workspace token broker unavailable: ${cause.message||cause}`);}
    const body=await response.json().catch(()=>({}));
    if(!response.ok||!body.access_token)throw new GoogleOAuthError(body.error||'WORKSPACE_BROKER_FAILED',`Workspace token broker failed: ${body.detail||`HTTP_${response.status}`}`,{status:response.status});
    if(body.principal!==this.expectedPrincipal||body.subject!==this.expectedSubject)throw new GoogleOAuthError('WORKSPACE_IDENTITY_MISMATCH','Workspace broker returned an unexpected principal or delegated subject',{expectedPrincipal:this.expectedPrincipal,expectedSubject:this.expectedSubject});
    this.cached={value:body.access_token,expiresAt:now+Math.max(1,Number(body.expires_in||3600))*1000};return this.cached.value;
  }
  clear(){this.cached=null;}
  toJSON(){return{type:'WorkspaceBrokerTokenProvider',provider:'cloud_run_iam_remote_signing_dwd',principal:this.expectedPrincipal,subject:this.expectedSubject,cached:Boolean(this.cached)};}
}

export function resolveGoogleOAuthCredentials({ env = process.env } = {}) {
  const inspection = inspectGoogleOAuthConfig({ env });
  if (!inspection.ok) throw new GoogleOAuthError(inspection.code, inspection.detail, inspection);
  if (inspection.mode === 'application_default') return {
    ...loadApplicationDefaultCredentials({ env, credentialsPath: inspection.credentialsPath }),
    token_uri: GOOGLE_OAUTH_TOKEN_ENDPOINT,
  };
  return {
    type: 'authorized_user', client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
    token_uri: env.GOOGLE_OAUTH_TOKEN_URI || GOOGLE_OAUTH_TOKEN_ENDPOINT,
  };
}

export class GoogleOAuthTokenProvider {
  constructor({ credentials, fetchImpl = globalThis.fetch, clock = () => new Date(), expirySkewSeconds = 60 } = {}) {
    const missing = requiredAuthorizedUserFields(credentials);
    if (missing.length) throw new GoogleOAuthError('GOOGLE_OAUTH_CREDENTIALS_MISSING', `OAuth credentials missing: ${missing.join(', ')}`);
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.credentials = credentials; this.fetch = fetchImpl; this.clock = clock; this.expirySkewMs = expirySkewSeconds * 1000;
    this.cached = null;
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    const now = this.clock().getTime();
    if (!forceRefresh && this.cached && now + this.expirySkewMs < this.cached.expiresAt) return this.cached.value;
    let response;
    try {
      response = await this.fetch(this.credentials.token_uri || GOOGLE_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.credentials.client_id, client_secret: this.credentials.client_secret,
          refresh_token: this.credentials.refresh_token, grant_type: 'refresh_token',
        }),
      });
    } catch (cause) {
      throw new GoogleOAuthError('GOOGLE_OAUTH_REFRESH_UNAVAILABLE', `OAuth token refresh failed: ${cause.message || cause}`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      const providerCode = body.error || `HTTP_${response.status}`;
      const providerSubtype=body.error_subtype||(/invalid_rapt/i.test(String(body.error_description||''))?'invalid_rapt':null);
      const code=providerSubtype==='invalid_rapt'?'GOOGLE_USER_RAPT_REQUIRED':providerCode==='invalid_grant'?'GOOGLE_USER_REFRESH_TOKEN_INVALID':providerCode==='invalid_client'?'GOOGLE_OAUTH_CLIENT_INVALID':providerCode==='unauthorized_client'?'GOOGLE_OAUTH_CLIENT_UNAUTHORIZED':'GOOGLE_OAUTH_REFRESH_FAILED';
      throw new GoogleOAuthError(code, `OAuth token refresh failed: ${providerSubtype||providerCode}`, { status: response.status, providerCode, providerSubtype });
    }
    const expiresIn = Number(body.expires_in || 3600);
    this.cached = { value: body.access_token, expiresAt: now + Math.max(1, expiresIn) * 1000 };
    return this.cached.value;
  }

  clear() { this.cached = null; }
  toJSON() { return { type: 'GoogleOAuthTokenProvider', cached: Boolean(this.cached) }; }
}

export class GoogleImpersonatedAdcTokenProvider {
  constructor({credentials,fetchImpl=globalThis.fetch,clock=()=>new Date(),expirySkewSeconds=60}={}){if(credentials?.type!=='impersonated_service_account'||!credentials.service_account_impersonation_url)throw new GoogleOAuthError('GOOGLE_ADC_INCOMPLETE','Impersonated Application Default Credentials are incomplete');this.credentials=credentials;this.fetch=fetchImpl;this.clock=clock;this.expirySkewMs=expirySkewSeconds*1000;this.source=new GoogleOAuthTokenProvider({credentials:{...credentials.source_credentials,token_uri:GOOGLE_OAUTH_TOKEN_ENDPOINT},fetchImpl,clock});this.cached=null;}
  async getAccessToken({forceRefresh=false}={}){const now=this.clock().getTime();if(!forceRefresh&&this.cached&&now+this.expirySkewMs<this.cached.expiresAt)return this.cached.value;const sourceToken=await this.source.getAccessToken({forceRefresh});const scopes=(this.credentials.scopes||['https://www.googleapis.com/auth/cloud-platform']).filter(Boolean);const response=await this.fetch(this.credentials.service_account_impersonation_url,{method:'POST',headers:{Authorization:`Bearer ${sourceToken}`,'Content-Type':'application/json'},body:JSON.stringify({delegates:this.credentials.delegates||[],scope:scopes,lifetime:'3600s'})});const body=await response.json().catch(()=>({}));if(!response.ok||!body.accessToken)throw new GoogleOAuthError('GOOGLE_ADC_IMPERSONATION_FAILED',`ADC service-account impersonation failed: ${body.error?.message||`HTTP_${response.status}`}`,{status:response.status});const expiresAt=new Date(body.expireTime||now+3600000).getTime();this.cached={value:body.accessToken,expiresAt:Number.isFinite(expiresAt)?expiresAt:now+3600000};return this.cached.value;}
  clear(){this.cached=null;this.source.clear();}toJSON(){return{type:'GoogleImpersonatedAdcTokenProvider',cached:Boolean(this.cached)};}
}

export class GoogleServiceAccountImpersonationTokenProvider {
  constructor({ credentials, subject, scopes = [GOOGLE_SHEETS_SCOPE], fetchImpl = globalThis.fetch, clock = () => new Date(), expirySkewSeconds = 60 } = {}) {
    if (!credentials?.client_email || !credentials?.private_key || !subject) throw new GoogleOAuthError('GOOGLE_MACHINE_CREDENTIALS_INCOMPLETE', 'Service account client_email, private_key, and impersonation subject are required');
    this.credentials=credentials;this.subject=subject;this.scopes=scopes;this.fetch=fetchImpl;this.clock=clock;this.expirySkewMs=expirySkewSeconds*1000;this.cached=null;
  }
  async getAccessToken({ forceRefresh=false }={}) {
    const now=this.clock().getTime();if(!forceRefresh&&this.cached&&now+this.expirySkewMs<this.cached.expiresAt)return this.cached.value;
    const issued=Math.floor(now/1000);const endpoint=this.credentials.token_uri||GOOGLE_OAUTH_TOKEN_ENDPOINT;
    const header=base64url({alg:'RS256',typ:'JWT'});const claims=base64url({iss:this.credentials.client_email,sub:this.subject,scope:this.scopes.join(' '),aud:endpoint,iat:issued,exp:issued+3600});
    let signature;try{const signer=createSign('RSA-SHA256');signer.update(`${header}.${claims}`);signer.end();signature=signer.sign(this.credentials.private_key).toString('base64url');}catch(cause){throw new GoogleOAuthError('GOOGLE_MACHINE_SIGNING_FAILED',`Machine credential signing failed: ${cause.message||cause}`);}
    const response=await this.fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${header}.${claims}.${signature}`})});
    const body=await response.json().catch(()=>({}));if(!response.ok||!body.access_token)throw new GoogleOAuthError('GOOGLE_MACHINE_TOKEN_FAILED',`Machine token exchange failed: ${body.error||`HTTP_${response.status}`}`,{status:response.status,providerCode:body.error||null});
    this.cached={value:body.access_token,expiresAt:now+Math.max(1,Number(body.expires_in||3600))*1000};return this.cached.value;
  }
  clear(){this.cached=null;} toJSON(){return{type:'GoogleServiceAccountImpersonationTokenProvider',principal:this.credentials.client_email,subject:this.subject,scopes:this.scopes,cached:Boolean(this.cached)};}
}

export class GoogleIamRemoteSigningTokenProvider {
  constructor({ sourceTokenProvider, serviceAccountEmail, subject, scopes = [GOOGLE_SHEETS_SCOPE], fetchImpl = globalThis.fetch, clock = () => new Date(), expirySkewSeconds = 60 } = {}) {
    if (!sourceTokenProvider?.getAccessToken || !serviceAccountEmail || !subject) throw new GoogleOAuthError('GOOGLE_REMOTE_SIGNER_INCOMPLETE', 'Source token provider, service-account email, and impersonation subject are required');
    this.sourceTokenProvider=sourceTokenProvider;this.serviceAccountEmail=serviceAccountEmail;this.subject=subject;this.scopes=scopes;this.fetch=fetchImpl;this.clock=clock;this.expirySkewMs=expirySkewSeconds*1000;this.cached=null;
  }
  async getAccessToken({ forceRefresh=false }={}) {
    const now=this.clock().getTime();if(!forceRefresh&&this.cached&&now+this.expirySkewMs<this.cached.expiresAt)return this.cached.value;
    const issued=Math.floor(now/1000);const header=base64url({alg:'RS256',typ:'JWT'});const claims=base64url({iss:this.serviceAccountEmail,sub:this.subject,scope:this.scopes.join(' '),aud:GOOGLE_OAUTH_TOKEN_ENDPOINT,iat:issued,exp:issued+3600});const unsigned=`${header}.${claims}`;
    const sourceToken=await this.sourceTokenProvider.getAccessToken({forceRefresh});
    const signerUrl=`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(this.serviceAccountEmail)}:signBlob`;
    let signResponse;try{signResponse=await this.fetch(signerUrl,{method:'POST',headers:{Authorization:`Bearer ${sourceToken}`,'Content-Type':'application/json'},body:JSON.stringify({payload:Buffer.from(unsigned).toString('base64')})});}catch(cause){throw new GoogleOAuthError('GOOGLE_IAM_SIGNING_UNAVAILABLE',`IAM remote signing failed: ${cause.message||cause}`);}
    const signed=await signResponse.json().catch(()=>({}));if(!signResponse.ok||!signed.signedBlob)throw new GoogleOAuthError('GOOGLE_IAM_SIGNING_FAILED',`IAM remote signing failed: ${signed.error?.message||`HTTP_${signResponse.status}`}`,{status:signResponse.status});
    const assertion=`${unsigned}.${Buffer.from(signed.signedBlob,'base64').toString('base64url')}`;
    const tokenResponse=await this.fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
    const body=await tokenResponse.json().catch(()=>({}));if(!tokenResponse.ok||!body.access_token)throw new GoogleOAuthError('DWD_TOKEN_EXCHANGE_FAILED',`Delegated Workspace token exchange failed: ${body.error_description||body.error||`HTTP_${tokenResponse.status}`}`,{status:tokenResponse.status,providerCode:body.error||null});
    this.cached={value:body.access_token,expiresAt:now+Math.max(1,Number(body.expires_in||3600))*1000};return this.cached.value;
  }
  clear(){this.cached=null;this.sourceTokenProvider.clear?.();}
  toJSON(){return{type:'GoogleIamRemoteSigningTokenProvider',principal:this.serviceAccountEmail,subject:this.subject,scopes:this.scopes,cached:Boolean(this.cached)};}
}

export function createGoogleOAuthTokenProviderFromEnv({ env = process.env, fetchImpl = globalThis.fetch, clock } = {}) {
  if (String(env.GOOGLE_SHEETS_AUTH_MODE || '').trim().toLowerCase() === 'workspace_broker') {
    const inspection=inspectGoogleOAuthConfig({env});if(!inspection.ok)throw new GoogleOAuthError(inspection.code,inspection.detail,inspection);
    return new WorkspaceBrokerTokenProvider({url:env.CAREER_OPS_WORKSPACE_BROKER_URL,secret:env.CAREER_OPS_WORKSPACE_BROKER_SECRET,expectedPrincipal:inspection.principal,expectedSubject:inspection.subject,fetchImpl,clock});
  }
  if (String(env.GOOGLE_SHEETS_AUTH_MODE || '').trim().toLowerCase() === 'iam_remote_signing') {
    const remote=loadIamRemoteSigningConfig({env});const sourceTokenProvider=remote.sourceCredentials.type==='impersonated_service_account'?new GoogleImpersonatedAdcTokenProvider({credentials:remote.sourceCredentials,fetchImpl,clock}):new GoogleOAuthTokenProvider({credentials:{...remote.sourceCredentials,token_uri:GOOGLE_OAUTH_TOKEN_ENDPOINT},fetchImpl,clock});return new GoogleIamRemoteSigningTokenProvider({sourceTokenProvider,serviceAccountEmail:remote.serviceAccountEmail,subject:remote.subject,scopes:remote.scopes,fetchImpl,clock});
  }
  if (String(env.GOOGLE_SHEETS_AUTH_MODE || '').trim().toLowerCase() === 'service_account_impersonation') {
    const machine=loadMachineCredentials({env});return new GoogleServiceAccountImpersonationTokenProvider({credentials:machine.credentials,subject:machine.subject,scopes:machine.scopes,fetchImpl,clock});
  }
  const credentials=resolveGoogleOAuthCredentials({env});return credentials.type==='impersonated_service_account'?new GoogleImpersonatedAdcTokenProvider({credentials,fetchImpl,clock}):new GoogleOAuthTokenProvider({credentials,fetchImpl,clock});
}
