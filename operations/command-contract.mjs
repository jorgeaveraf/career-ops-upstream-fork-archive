import { createHash, timingSafeEqual } from 'crypto';

export const COMMAND_VERSION = '3A.1';
export const COMMAND_TYPES = Object.freeze(['jobs.sync', 'communities.sync']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateCommandEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('command envelope must be an object');
  const required = ['command_version','command_id','command_type','requested_at','source','sheet_id','requested_by','correlation_id','payload'];
  for (const key of required) if (!(key in value)) throw new TypeError(`missing ${key}`);
  if (value.command_version !== COMMAND_VERSION) throw new TypeError('unsupported command_version');
  if (!UUID.test(String(value.command_id))) throw new TypeError('command_id must be a UUID');
  if (!COMMAND_TYPES.includes(value.command_type)) throw new TypeError('unsupported command_type');
  const requestedAt = new Date(value.requested_at);
  if (Number.isNaN(requestedAt.getTime())) throw new TypeError('requested_at must be an ISO timestamp');
  if (value.source !== 'google_sheet') throw new TypeError('unsupported command source');
  for (const key of ['sheet_id','requested_by','correlation_id']) if (!String(value[key] || '').trim()) throw new TypeError(`${key} is required`);
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) throw new TypeError('payload must be an object');
  return { ...value, requested_at: requestedAt.toISOString(), payload: structuredClone(value.payload) };
}

export function commandPayloadHash(envelope) {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

export function deterministicLegacyCommandId(value) {
  const hex=createHash('sha256').update(String(value)).digest('hex').slice(0,32).split('');
  hex[12]='5';hex[16]=['8','9','a','b'][Number.parseInt(hex[16],16)%4];
  return `${hex.slice(0,8).join('')}-${hex.slice(8,12).join('')}-${hex.slice(12,16).join('')}-${hex.slice(16,20).join('')}-${hex.slice(20).join('')}`;
}

export function canonicalSignatureInput({ timestamp, requestId, rawBody }) {
  return `${timestamp}\n${requestId}\n${rawBody}`;
}

export function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}
