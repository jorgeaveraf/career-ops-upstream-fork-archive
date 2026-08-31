const normalizeEmail = value => String(value || '').trim().toLowerCase();
const emailLike = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));

export const GOOGLE_ACCOUNT_STATES = Object.freeze([
  'AUTHENTICATED', 'NOT_AUTHENTICATED', 'AUTH_REQUIRED', 'CHALLENGE', 'VERIFICATION_UNKNOWN',
]);

function sanitizeAccounts(accounts = []) {
  const seen = new Set();
  return (Array.isArray(accounts) ? accounts : []).flatMap(item => {
    const email = normalizeEmail(item?.email);
    if (!emailLike(email) || seen.has(email)) return [];
    seen.add(email);
    return [{ email, runtimeRef: item.runtimeRef ?? null, active: item.active === true }];
  });
}

export class GoogleAccountResolver {
  constructor({ browserPort, chromeProfile = 'Jorge' } = {}) {
    if (!browserPort) throw new TypeError('browserPort is required');
    this.browserPort = browserPort;
    this.chromeProfile = String(chromeProfile || '').trim();
    if (this.chromeProfile.toLowerCase() !== 'jorge') throw new Error('Google browser account resolution requires Chrome profile Jorge');
  }

  async discover() {
    const observed = await this.browserPort.discoverGoogleAccounts({ chromeProfile: this.chromeProfile });
    if (['AUTH_REQUIRED', 'CHALLENGE'].includes(observed?.state)) return { state: observed.state, accounts: [], chromeProfile: this.chromeProfile };
    return { state: observed?.state || 'VERIFICATION_UNKNOWN', accounts: sanitizeAccounts(observed?.accounts), chromeProfile: this.chromeProfile };
  }

  async resolve(requestedIdentity) {
    const requested = normalizeEmail(requestedIdentity);
    if (!emailLike(requested)) throw new TypeError('requested Google identity must be an email address');
    const discovery = await this.discover();
    if (['AUTH_REQUIRED', 'CHALLENGE'].includes(discovery.state)) return { ...discovery, requestedIdentity: requested, resolved: false, runtimeRef: null };
    const account = discovery.accounts.find(item => item.email === requested);
    if (!account) return { ...discovery, state: discovery.state === 'AUTHENTICATED' ? 'NOT_AUTHENTICATED' : discovery.state, requestedIdentity: requested, resolved: false, runtimeRef: null };
    return { ...discovery, state: 'AUTHENTICATED', requestedIdentity: requested, resolved: true, runtimeRef: account.runtimeRef, active: account.active };
  }
}

export function sanitizedGoogleAccountTelemetry(resolution) {
  return {
    chromeProfile: resolution?.chromeProfile || 'Jorge',
    requestedGoogleIdentity: normalizeEmail(resolution?.requestedIdentity),
    resolved: resolution?.resolved === true,
    state: resolution?.state || 'VERIFICATION_UNKNOWN',
    discoveredIdentities: sanitizeAccounts(resolution?.accounts).map(item => item.email),
    runtimeAccountRef: resolution?.runtimeRef ?? null,
  };
}
