import { AtsChromeApplicationAdapter } from './ats-chrome-adapter.mjs';
import { GenericBrowserApplicationExecutor } from './generic-browser-executor.mjs';
import { selectApplicationChromeProfile } from './browser-profile.mjs';
import { PlatformAccountProvisioner } from './account-provisioning.mjs';
import { MacOsKeychainCredentialStore } from './credential-store.mjs';
import { BrowserSignupVerificationReader } from './browser-verification-reader.mjs';
import { MacOsChromeWindowDriver } from '../research/macos-chrome-window-driver.mjs';

export function createProductionApplicationExecutors({ env = process.env, registry = null, accountProvisioner = null, verificationReader = null } = {}) {
  const executors = {};
  if (String(env.APPLICATION_EXECUTION_BROWSER_ENABLED || '').toLowerCase() !== 'true') return executors;
  const driver = new MacOsChromeWindowDriver();
  const reader = verificationReader || new BrowserSignupVerificationReader({ driver });
  const provisioner = accountProvisioner || (registry ? new PlatformAccountProvisioner({ registry, credentialStore: new MacOsKeychainCredentialStore(), verificationReader: reader }) : null);
  executors.ATS = new AtsChromeApplicationAdapter({ env });
  executors.GENERIC_BROWSER = new GenericBrowserApplicationExecutor({ env, registry, accountProvisioner: provisioner, driver });
  return executors;
}

export function inspectProductionApplicationTransports({ env = process.env } = {}) {
  const email = { status: 'UNAVAILABLE', detail: 'No production email sender configured' };
  if (String(env.APPLICATION_EXECUTION_BROWSER_ENABLED || '').toLowerCase() !== 'true') return { ats: { status: 'UNAVAILABLE', detail: 'Application browser transport disabled' }, genericBrowser: { status: 'UNAVAILABLE', detail: 'Generic browser executor disabled' }, email };
  try {
    const profile = selectApplicationChromeProfile({ profile: env.APPLICATION_BROWSER_PROFILE || 'jorge', mode: env.APPLICATION_BROWSER_MODE || 'application_submit', userDataDir: env.APPLICATION_BROWSER_USER_DATA_DIR || env.BROWSER_USER_DATA_DIR });
    return { ats: { status: 'READY', detail: `Exact-authorized managed Chrome transport (${profile.profileName})` }, genericBrowser: { status: 'READY', detail: `Universal semantic form executor (${profile.profileName})` }, email };
  } catch (error) {
    return { ats: { status: 'UNAVAILABLE', detail: error.message }, genericBrowser: { status: 'UNAVAILABLE', detail: error.message }, email };
  }
}
