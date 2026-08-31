import { hashStable } from '../acquisition/normalize.mjs';
import { sanitizedGoogleAccountTelemetry } from './google-account-resolver.mjs';

const normalize = value => String(value || '').trim().toLowerCase();
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function buildSupabaseConfirmationQuery() {
  return '(Supabase OR Ashby) ("Pre-Sales Solutions Architect" OR "application received" OR "application submitted" OR "thanks for applying" OR "thank you for applying")';
}

export function classifySupabaseConfirmationEmail(message = {}) {
  const sender = clean(message.sender);
  const subject = clean(message.subject);
  const snippet = clean(message.snippet);
  const haystack = `${sender} ${subject} ${snippet}`.toLowerCase();
  const target = /supabase|pre-sales solutions architect/.test(haystack);
  const trustedContext = /ashby|supabase/.test(`${sender} ${subject}`.toLowerCase());
  const explicit = /application (?:was )?(?:received|submitted)|thanks for applying|thank you for applying|we(?:'|’)ve received your application|we have received your application/.test(haystack);
  return target && trustedContext && explicit ? 'APPLIED_CONFIRMED' : 'NOT_A_CONFIRMATION';
}

function sanitizedEvidence(message, { mailboxIdentity, runId, clock }) {
  const evidence = {
    mailboxIdentity: normalize(mailboxIdentity), sender: clean(message.sender), subject: clean(message.subject),
    timestamp: message.timestamp || null, matchedCompany: 'Supabase', matchedJob: 'Pre-Sales Solutions Architect (SA) Leader',
    confirmationClassification: 'APPLIED_CONFIRMED', runId, observedAt: clock().toISOString(),
  };
  return { ...evidence, evidenceHash: hashStable(JSON.stringify(evidence)) };
}

export class GmailBrowserSearchAdapter {
  constructor({ resolver, browserPort, clock = () => new Date() } = {}) {
    if (!resolver || !browserPort) throw new TypeError('resolver and browserPort are required');
    this.resolver = resolver; this.browserPort = browserPort; this.clock = clock;
  }

  async searchSupabaseConfirmation({ requestedIdentity, runId } = {}) {
    const resolution = await this.resolver.resolve(requestedIdentity);
    const telemetry = sanitizedGoogleAccountTelemetry(resolution);
    if (resolution.state !== 'AUTHENTICATED' || !resolution.resolved) return { state: resolution.state, resolved: false, telemetry, matches: [], evidence: null };
    await this.browserPort.openGmailAccount({ runtimeRef: resolution.runtimeRef, requestedIdentity: resolution.requestedIdentity });
    let activeIdentity = normalize(await this.browserPort.readActiveGmailIdentity());
    if (activeIdentity !== resolution.requestedIdentity) {
      await this.browserPort.activateGoogleAccount({ runtimeRef: resolution.runtimeRef, requestedIdentity: resolution.requestedIdentity });
      activeIdentity = normalize(await this.browserPort.readActiveGmailIdentity());
    }
    if (activeIdentity !== resolution.requestedIdentity) return { state:'VERIFICATION_UNKNOWN', resolved:false, telemetry:{...telemetry,activeMailboxIdentity:activeIdentity}, matches:[], evidence:null };
    const query = buildSupabaseConfirmationQuery();
    const messages = await this.browserPort.searchGmail({ query, mailboxIdentity:activeIdentity });
    const match = (Array.isArray(messages) ? messages : []).find(message => classifySupabaseConfirmationEmail(message) === 'APPLIED_CONFIRMED');
    if (!match) return { state:'EMAIL_CONFIRMATION_NOT_FOUND', resolved:true, mailboxIdentity:activeIdentity, query, telemetry:{...telemetry,activeMailboxIdentity:activeIdentity}, matches:[], evidence:null };
    const evidence = sanitizedEvidence(match, { mailboxIdentity:activeIdentity, runId, clock:this.clock });
    return { state:'APPLIED_CONFIRMED', resolved:true, mailboxIdentity:activeIdentity, query, telemetry:{...telemetry,activeMailboxIdentity:activeIdentity}, matches:[{sender:evidence.sender,subject:evidence.subject,timestamp:evidence.timestamp}], evidence };
  }
}
