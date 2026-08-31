import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';

const SERVICE_PREFIX = 'career-ops-platform';
const text = (value, name) => { const result = String(value || '').trim(); if (!result) throw new TypeError(`${name} is required`); return result; };

export function generateStrongCredential(bytes = 21) {
  const portableEntropyBytes = Math.max(18, Math.min(21, bytes));
  return `${randomBytes(portableEntropyBytes).toString('base64url')}!aA7`;
}

export class MacOsKeychainCredentialStore {
  constructor({ exec = execFileSync, platform = process.platform, servicePrefix = SERVICE_PREFIX } = {}) { this.exec = exec; this.platform = platform; this.servicePrefix = servicePrefix; }
  service(platformKey) { return `${this.servicePrefix}:${text(platformKey, 'platformKey').toLowerCase()}`; }
  health() {
    if (this.platform !== 'darwin') return { status: 'UNAVAILABLE', detail: 'macOS Keychain is required' };
    try { this.exec('/usr/bin/security', ['list-keychains'], { stdio: ['ignore', 'pipe', 'ignore'] }); return { status: 'READY', detail: 'macOS Keychain protected credential references' }; }
    catch (error) { return { status: 'UNAVAILABLE', detail: error.code || 'KEYCHAIN_UNAVAILABLE' }; }
  }
  put({ platformKey, accountEmail, password }) {
    if (this.health().status !== 'READY') throw Object.assign(new Error('approved secure credential store is unavailable'), { code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    const account = text(accountEmail, 'accountEmail'), service = this.service(platformKey), secret = text(password, 'password');
    this.exec('/usr/bin/security', ['add-generic-password', '-U', '-a', account, '-s', service, '-w', secret], { stdio: ['ignore', 'ignore', 'ignore'] });
    return `keychain://${encodeURIComponent(service)}/${encodeURIComponent(account)}`;
  }
  get({ platformKey, accountEmail }) {
    const account = text(accountEmail, 'accountEmail'), service = this.service(platformKey);
    return String(this.exec('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  }
}
