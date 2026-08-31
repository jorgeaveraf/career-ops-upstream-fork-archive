import { createHmac, timingSafeEqual } from 'crypto';

export const COMMAND_VERSION = '3A.1';
export const COMMAND_TYPES = Object.freeze(['jobs.sync', 'communities.sync']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const signatureInput = ({ timestamp, requestId, rawBody }) => `${timestamp}\n${requestId}\n${rawBody}`;
export const signRequest = ({ secret, timestamp, requestId, rawBody }) => createHmac('sha256', secret).update(signatureInput({ timestamp, requestId, rawBody })).digest('base64url');
export function signaturesEqual(left, right) { const a=Buffer.from(String(left||'')),b=Buffer.from(String(right||''));return a.length===b.length&&timingSafeEqual(a,b); }

export function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new TypeError('command envelope must be an object'), { statusCode: 400 });
  const required=['command_version','command_id','command_type','requested_at','source','sheet_id','requested_by','correlation_id','payload'];
  for(const key of required)if(!(key in value))throw Object.assign(new TypeError(`missing ${key}`),{statusCode:400});
  if(value.command_version!==COMMAND_VERSION)throw Object.assign(new TypeError('unsupported command_version'),{statusCode:400});
  if(!UUID.test(String(value.command_id)))throw Object.assign(new TypeError('command_id must be a UUID'),{statusCode:400});
  if(!COMMAND_TYPES.includes(value.command_type))throw Object.assign(new TypeError('unsupported command_type'),{statusCode:400});
  const requestedAt=new Date(value.requested_at);if(Number.isNaN(requestedAt.getTime()))throw Object.assign(new TypeError('requested_at must be an ISO timestamp'),{statusCode:400});
  if(value.source!=='google_sheet')throw Object.assign(new TypeError('unsupported command source'),{statusCode:400});
  for(const key of ['sheet_id','requested_by','correlation_id'])if(!String(value[key]||'').trim())throw Object.assign(new TypeError(`${key} is required`),{statusCode:400});
  if(!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload))throw Object.assign(new TypeError('payload must be an object'),{statusCode:400});
  return value;
}
