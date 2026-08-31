import { existsSync, readFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const normalize = value => String(value || '').trim().toLowerCase();
const emailLike = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const list = value => Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];

export function loadIdentityRouting({ profilePath = 'config/profile.yml' } = {}) {
  const absolute = path.resolve(profilePath);
  if (!existsSync(absolute)) return null;
  const profile = yaml.load(readFileSync(absolute, 'utf8')) || {};
  if (!profile.identity_routing) return null;
  return { ...profile.identity_routing, candidate_email: profile.candidate?.email || null };
}

export function validateIdentityRouting(routing, { env = process.env } = {}) {
  if (!routing) return { ok: true, configured: false, errors: [], routes: {} };
  const errors = [];
  const workspace = routing.google_workspace_gcp || {};
  const browser = routing.browser_job_search || {};
  const applicationEmail = routing.application_email || {};
  const systemNotification = routing.system_notification || {};
  const platformSignup = routing.platform_signup || {};
  const routes = {
    googleWorkspaceGcp: { identity: workspace.identity, principal: workspace.principal, purposes: list(workspace.purposes) },
    browserJobSearch: { chromeProfile: browser.chrome_profile, purposes: list(browser.purposes) },
    applicationEmail: { sender: applicationEmail.sender, purposes: list(applicationEmail.purposes) },
    systemNotification: { sender:systemNotification.sender, recipient:systemNotification.recipient, purposes:list(systemNotification.purposes) },
    platformSignup: { accountEmail: platformSignup.account_email, purposes: list(platformSignup.purposes), prohibitedUses: list(platformSignup.prohibited_uses), exceptionPolicy: platformSignup.exception_policy },
  };
  if (Number(routing.version) !== 1) errors.push({ code: 'IDENTITY_ROUTING_VERSION_INVALID', message: 'identity_routing.version must be 1' });
  if (!emailLike(workspace.principal)) errors.push({ code: 'WORKSPACE_PRINCIPAL_INVALID', message: 'Google Workspace/GCP principal must be an email address' });
  if (!String(browser.chrome_profile || '').trim()) errors.push({ code: 'JOB_BROWSER_PROFILE_MISSING', message: 'Job-search Chrome profile is required' });
  if (!emailLike(applicationEmail.sender)) errors.push({ code: 'APPLICATION_SENDER_INVALID', message: 'Application sender must be an email address' });
  if(Object.keys(systemNotification).length){if(!emailLike(systemNotification.sender))errors.push({code:'SYSTEM_NOTIFICATION_SENDER_INVALID',message:'System notification sender must be an email address'});if(!emailLike(systemNotification.recipient))errors.push({code:'SYSTEM_NOTIFICATION_RECIPIENT_INVALID',message:'System notification recipient must be an email address'});if(normalize(systemNotification.recipient)!==normalize(routing.candidate_email))errors.push({code:'SYSTEM_NOTIFICATION_RECIPIENT_CANDIDATE_MISMATCH',message:'System notifications must go to candidate.email'});if(normalize(systemNotification.recipient)===normalize(platformSignup.account_email))errors.push({code:'SYSTEM_NOTIFICATION_SIGNUP_IDENTITY_FORBIDDEN',message:'Platform sign-up identity cannot receive system notifications'});if(!routes.systemNotification.purposes.includes('SYSTEM_NOTIFICATION_SEND'))errors.push({code:'SYSTEM_NOTIFICATION_PURPOSE_MISSING',message:'System notification route must include SYSTEM_NOTIFICATION_SEND'});}
  if (!emailLike(platformSignup.account_email)) errors.push({ code: 'PLATFORM_SIGNUP_EMAIL_INVALID', message: 'Platform sign-up email must be an email address' });
  if (normalize(applicationEmail.sender) !== normalize(routing.candidate_email)) errors.push({ code: 'APPLICATION_SENDER_CANDIDATE_MISMATCH', message: 'Application sender must match candidate.email' });
  if (normalize(workspace.principal) === normalize(routing.candidate_email)) errors.push({ code: 'WORKSPACE_CANDIDATE_IDENTITY_COLLISION', message: 'Workspace control-plane principal must remain separate from Candidate Gmail' });
  if (normalize(platformSignup.account_email) === normalize(applicationEmail.sender)) errors.push({ code: 'PLATFORM_SIGNUP_NOT_SEPARATE', message: 'Platform sign-up email must remain separate from the application sender' });
  for (const prohibited of ['APPLICATION_SENDER', 'CONTACT_SENDER']) if (!routes.platformSignup.prohibitedUses.includes(prohibited)) errors.push({ code: 'PLATFORM_SIGNUP_PROHIBITION_MISSING', message: `Platform sign-up routing must prohibit ${prohibited}` });
  if (platformSignup.exception_policy !== 'EXPLICIT_USER_AUTHORIZATION_REQUIRED') errors.push({ code: 'PLATFORM_SIGNUP_EXCEPTION_POLICY_INVALID', message: 'Platform sign-up exceptions require explicit user authorization' });
  if (env.GOOGLE_IMPERSONATION_SUBJECT && normalize(env.GOOGLE_IMPERSONATION_SUBJECT) !== normalize(workspace.principal)) errors.push({ code: 'WORKSPACE_PRINCIPAL_ENV_MISMATCH', message: 'Configured Google impersonation subject does not match identity routing' });
  for (const name of ['BROWSER_PROFILE', 'APPLICATION_BROWSER_PROFILE']) if (env[name] && normalize(env[name]) !== normalize(browser.chrome_profile)) errors.push({ code: `${name}_MISMATCH`, message: `${name} does not match the job-search Chrome profile` });
  return { ok: errors.length === 0, configured: true, errors, routes };
}

export function inspectIdentityRouting({ profilePath = 'config/profile.yml', env = process.env } = {}) {
  try { return validateIdentityRouting(loadIdentityRouting({ profilePath }), { env }); }
  catch (error) { return { ok: false, configured: true, errors: [{ code: 'IDENTITY_ROUTING_INVALID', message: error.message }], routes: {} }; }
}

export function resolveIdentityForPurpose(routing, purpose) {
  const wanted = String(purpose || '').trim().toUpperCase();
  if (!wanted) throw new TypeError('identity-routing purpose is required');
  const checked = validateIdentityRouting(routing, { env: {} });
  if (!checked.ok) throw new Error(`identity routing is invalid: ${checked.errors.map(item => item.code).join(', ')}`);
  const r = checked.routes;
  if (wanted === 'APPLICATION_EMAIL_READ') return { channel: 'APPLICATION_EMAIL', sender: r.applicationEmail.sender };
  if (r.systemNotification?.purposes.includes(wanted)) return {channel:'SYSTEM_NOTIFICATION',sender:r.systemNotification.sender,recipient:r.systemNotification.recipient};
  if (r.googleWorkspaceGcp.purposes.includes(wanted)) return { channel: 'GOOGLE_WORKSPACE_GCP', identity: r.googleWorkspaceGcp.identity, principal: r.googleWorkspaceGcp.principal };
  if (r.browserJobSearch.purposes.includes(wanted)) return { channel: 'BROWSER_JOB_SEARCH', chromeProfile: r.browserJobSearch.chromeProfile };
  if (r.applicationEmail.purposes.includes(wanted)) return { channel: 'APPLICATION_EMAIL', sender: r.applicationEmail.sender };
  if (r.platformSignup.prohibitedUses.includes(wanted)) return { channel: 'DENIED', reason: 'EXPLICIT_USER_AUTHORIZATION_REQUIRED', accountEmail: r.platformSignup.accountEmail };
  if (r.platformSignup.purposes.includes(wanted)) return { channel: 'PLATFORM_SIGNUP', accountEmail: r.platformSignup.accountEmail };
  return { channel: 'UNROUTED', purpose: wanted };
}
