import { generateStrongCredential } from './credential-store.mjs';

export const PLATFORM_SIGNUP_EMAIL = 'fubifo@gmail.com';

export function platformKeyFromUrl(url) { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }

export class PlatformAccountProvisioner {
  constructor({ registry, credentialStore, verificationReader = null, clock = () => new Date() } = {}) {
    if (!registry || !credentialStore) throw new TypeError('registry and credentialStore are required');
    this.registry = registry; this.credentialStore = credentialStore; this.verificationReader = verificationReader; this.clock = clock;
  }
  health() {
    const credential = this.credentialStore.health();
    return { status: credential.status === 'READY' && this.verificationReader ? 'READY' : 'DEGRADED', signupEmail: PLATFORM_SIGNUP_EMAIL, credentialStore: credential.status, verificationReader: this.verificationReader ? 'READY' : 'UNAVAILABLE' };
  }
  existing({ platformKey }) { return this.registry.getPlatformAccount?.({ platformKey, accountEmail: PLATFORM_SIGNUP_EMAIL }) || null; }
  prepare({ platformKey, executionId }) {
    const existing = this.existing({ platformKey });
    if (existing && ['ACTIVE','PENDING_VERIFICATION'].includes(existing.status)) return { account: existing, existing: true, password: this.credentialStore.get({ platformKey, accountEmail: PLATFORM_SIGNUP_EMAIL }) };
    const password = generateStrongCredential();
    const credentialReference = this.credentialStore.put({ platformKey, accountEmail: PLATFORM_SIGNUP_EMAIL, password });
    const account = this.registry.upsertPlatformAccount({ platformKey, accountEmail: PLATFORM_SIGNUP_EMAIL, profileIdentity: 'Jorge', status: 'PENDING_VERIFICATION', credentialReference, metadata: { pendingExecutionId: executionId } });
    return { account, existing: false, password };
  }
  async verify({ account, executionId, requestedAt, browserContext = null }) {
    if (!this.verificationReader) return { status: 'FAILED', code: 'SIGNUP_INBOX_UNAVAILABLE' };
    const result = await this.verificationReader.findVerification({ platform: account.platformKey, recipient: PLATFORM_SIGNUP_EMAIL, requestedAt, executionId, browserContext });
    if (!result?.verified) return { status: result?.securityCode ? 'SECURITY_BLOCKED' : 'FAILED', code: result?.securityCode || 'VERIFICATION_EMAIL_NOT_FOUND' };
    this.registry.verifyPlatformAccount(account.id, { evidence: result.evidence || {}, verifiedAt: this.clock().toISOString(), executionId });
    return { status: 'VERIFIED', evidence: result.evidence || {} };
  }
}
