#!/usr/bin/env node
import 'dotenv/config';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { createGoogleOAuthTokenProviderFromEnv, defaultApplicationCredentialsPath, GOOGLE_SHEETS_SCOPE, inspectGoogleOAuthConfig } from './operations/google-oauth.mjs';

const GCLOUD_ADC_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  GOOGLE_SHEETS_SCOPE,
].join(',');

function usage() {
  console.log(`Usage:
  npm run google:auth -- status [--json]
  npm run google:auth -- authorize
  npm run google:auth -- revoke

authorize/revoke use gcloud Application Default Credentials. Access tokens are
renewed in memory and are never written to .env, logs, or application data.
When GOOGLE_OAUTH_CLIENT_FILE is set, authorize uses that Desktop OAuth client.`);
}

function runGcloud(args) {
  const result = spawnSync('gcloud', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gcloud exited with status ${result.status}`);
}

export function googleAuthorizeArgs({ env = process.env } = {}) {
  const args = ['auth', 'application-default', 'login', `--scopes=${GCLOUD_ADC_SCOPES}`];
  const clientFile = String(env.GOOGLE_OAUTH_CLIENT_FILE || '').trim();
  if (clientFile) args.push(`--client-id-file=${clientFile}`);
  return args;
}

export async function googleAuthStatus({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = inspectGoogleOAuthConfig({ env });
  if (!config.ok) return { status: 'UNCONFIGURED', ok: false, mode: config.mode, code: config.code, detail: config.detail };
  try {
    await createGoogleOAuthTokenProviderFromEnv({ env, fetchImpl }).getAccessToken();
    return { status: 'OK', ok: true, mode: config.mode, credentialSource: config.credentialSource, credentialsPath: config.credentialsPath || null };
  } catch (error) {
    return { status: 'REAUTH_REQUIRED', ok: false, mode: config.mode, code: error.code || 'GOOGLE_OAUTH_FAILED', detail: error.message, credentialsPath: config.credentialsPath || null };
  }
}

async function main() {
  const args = process.argv.slice(2); const command = args[0] || 'status'; const json = args.includes('--json');
  if (['--help', '-h', 'help'].includes(command)) { usage(); return; }
  if (command === 'status') {
    const result = await googleAuthStatus();
    console.log(json ? JSON.stringify(result, null, 2) : `Google OAuth: ${result.status}\nMode: ${result.mode || 'unconfigured'}\nCredentials: ${result.credentialsPath || result.credentialSource || 'unavailable'}${result.detail ? `\nDetail: ${result.detail}` : ''}`);
    process.exitCode = result.ok ? 0 : 1; return;
  }
  if (String(process.env.GOOGLE_SHEETS_AUTH_MODE || '').toLowerCase() !== 'application_default') throw new Error('authorize/revoke require GOOGLE_SHEETS_AUTH_MODE=application_default');
  if (command === 'authorize') {
    runGcloud(googleAuthorizeArgs());
    console.log(`Application Default Credentials saved at ${defaultApplicationCredentialsPath()}`); return;
  }
  if (command === 'revoke') {
    runGcloud(['auth', 'application-default', 'revoke']);
    console.log('Application Default Credentials revoked and removed by gcloud.'); return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`Google auth failed: ${error.message}`); process.exitCode = 1; });
