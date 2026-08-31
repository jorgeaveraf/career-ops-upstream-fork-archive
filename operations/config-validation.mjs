import { existsSync, statSync } from 'fs';
import path from 'path';
import { createGoogleOAuthTokenProviderFromEnv, inspectGoogleOAuthConfig } from './google-oauth.mjs';
import { GoogleSheetsApiAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { inspectIdentityRouting } from './identity-routing.mjs';

const requiredFile = (projectRoot, relative) => existsSync(path.resolve(projectRoot, relative));

export function validateOperationalConfig({
  env = process.env, projectRoot = process.cwd(), dbPath = env.CAREER_OPS_DB || 'data/career.db',
  requireDatabase = true,
} = {}) {
  const errors = []; const warnings = [];
  const missingFiles = ['cv.md', 'config/profile.yml', 'portals.yml', 'candidate/manifest.yml']
    .filter(relative => !requiredFile(projectRoot, relative));
  if (missingFiles.length) errors.push({ code: 'REQUIRED_FILE_MISSING', message: `Missing required files: ${missingFiles.join(', ')}` });
  const absoluteDb = path.resolve(projectRoot, dbPath);
  if (requireDatabase && !existsSync(absoluteDb)) errors.push({ code: 'DATABASE_MISSING', message: `SQLite database not found: ${absoluteDb}` });
  if (!env.CAREER_OPS_SHEET_ID) errors.push({ code: 'SHEET_ID_MISSING', message: 'CAREER_OPS_SHEET_ID is required' });
  const googleOAuth = inspectGoogleOAuthConfig({ env });
  if (!googleOAuth.ok) errors.push({ code: googleOAuth.code, message: googleOAuth.detail });
  if(String(env.CAREER_OPS_PRODUCTION||'').toLowerCase()==='true'){
    if(googleOAuth.mode!=='workspace_broker')errors.push({code:'PRODUCTION_WORKSPACE_PROVIDER_DRIFT',message:'Production Workspace auth must remain pinned to workspace_broker; user ADC and candidate OAuth are forbidden'});
    if(String(env.CAREER_OPS_COMMAND_SUBSCRIBER_PROVIDER||'').toLowerCase()!=='command_gateway_pull')errors.push({code:'PRODUCTION_COMMAND_PROVIDER_DRIFT',message:'Production command subscriber must remain pinned to command_gateway_pull'});
    if(String(env.GOOGLE_APPLICATION_CREDENTIALS||'').trim())warnings.push({code:'UNUSED_GOOGLE_APPLICATION_CREDENTIALS',message:'GOOGLE_APPLICATION_CREDENTIALS is ignored by the pinned production providers'});
  }
  const identityRouting = inspectIdentityRouting({ profilePath: path.resolve(projectRoot, 'config/profile.yml'), env });
  if (!identityRouting.ok) errors.push(...identityRouting.errors);
  const notificationsEnabled = String(env.CAREER_OPS_NOTIFICATIONS_ENABLED).toLowerCase() === 'true';
  if (notificationsEnabled) {
    for (const name of ['RESEND_API_KEY', 'CAREER_OPS_EMAIL_FROM']) {
      if (!env[name]) errors.push({ code: `${name}_MISSING`, message: `${name} is required when notifications are enabled` });
    }
    const recipient=env.CAREER_OPS_NOTIFICATION_RECIPIENT||env.CAREER_OPS_EMAIL_TO;
    if(!recipient)errors.push({code:'CAREER_OPS_NOTIFICATION_RECIPIENT_MISSING',message:'Notification recipient is required when notifications are enabled'});
    if(String(recipient||'').toLowerCase()==='fubifo@gmail.com')errors.push({code:'NOTIFICATION_RECIPIENT_FORBIDDEN',message:'Platform sign-up identity cannot receive notifications'});
    if (env.CAREER_OPS_EMAIL_PROVIDER && String(env.CAREER_OPS_EMAIL_PROVIDER).toLowerCase() !== 'resend') {
      errors.push({ code: 'EMAIL_PROVIDER_UNSUPPORTED', message: `Unsupported email provider: ${env.CAREER_OPS_EMAIL_PROVIDER}` });
    }
  } else warnings.push({ code: 'NOTIFICATIONS_DISABLED', message: 'Email notifications are disabled' });
  const envPath = path.resolve(projectRoot, '.env');
  if (existsSync(envPath)) {
    const mode = statSync(envPath).mode & 0o777;
    if ((mode & 0o077) !== 0) errors.push({ code: 'ENV_PERMISSIONS_UNSAFE', message: '.env must not be readable or writable by group/others; run chmod 600 .env' });
  } else warnings.push({ code: 'ENV_FILE_ABSENT', message: 'No .env file found; launchd must receive configuration another secure way' });
  return { ok: errors.length === 0, errors, warnings, databasePath: absoluteDb, notificationsEnabled, googleOAuth, identityRouting };
}

export class StartupValidationError extends Error {
  constructor(result) {
    super(`startup validation failed: ${result.errors.map(item => item.code).join(', ')}`);
    this.name = 'StartupValidationError'; this.code = 'STARTUP_VALIDATION_FAILED'; this.result = result;
  }
}

export function assertStartupReady(options) {
  const result = validateOperationalConfig(options);
  if (!result.ok) throw new StartupValidationError(result);
  return result;
}

export async function validateStartupServiceAccess({ env = process.env, fetchImpl = globalThis.fetch, tokenProvider = null } = {}) {
  const spreadsheetId = env.CAREER_OPS_SHEET_ID;
  const config = validateOperationalConfig({ env });
  if (!spreadsheetId || !config.googleOAuth.ok) throw new StartupValidationError(config);
  try {
    const renewableTokenProvider = tokenProvider || createGoogleOAuthTokenProviderFromEnv({ env, fetchImpl });
    const adapter = new GoogleSheetsApiAdapter({ spreadsheetId, tokenProvider: renewableTokenProvider, fetchImpl });
    await adapter.request(`${adapter.base}?fields=spreadsheetId`);
  } catch (cause) {
    const error = new Error(`Google Sheets startup preflight failed: ${cause.message || cause}`);
    error.code = 'SHEETS_ACCESS_UNAVAILABLE'; throw error;
  }
  return { ok: true, spreadsheetId, authentication: 'oauth_refresh' };
}
