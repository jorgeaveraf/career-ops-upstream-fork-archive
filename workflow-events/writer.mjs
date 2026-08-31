import { createHash, randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { WORKFLOW_EVENT_VERSION, validateWorkflowEvent } from './contracts.mjs';

export const workflowEventContext = new AsyncLocalStorage();
const counters = { written: 0, rejected: 0, duplicatesAvoided: 0 };
const FORBIDDEN_KEYS = /^(password|secret|token|cookie|authorization|resume|cover_letter|html|raw_html)$/i;

function sanitize(value, depth = 0) {
  if (depth > 6) return '[depth-limited]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 1000 ? `${value.slice(0, 997)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !FORBIDDEN_KEYS.test(key)).map(([key, item]) => [key, sanitize(item, depth + 1)]));
  return String(value);
}

export class WorkflowEventWriter {
  constructor({ db, clock = () => new Date() } = {}) {
    if (!db) throw new TypeError('db is required');
    this.db = db; this.clock = clock;
  }

  append(input = {}) {
    try {
      const context = workflowEventContext.getStore() || {};
      const clean = validateWorkflowEvent({ ...context, ...input, correlationId: input.correlationId || context.correlationId, commandId: input.commandId ?? context.commandId, causationId: input.causationId ?? context.causationId });
      const occurredAt = new Date(clean.occurredAt || this.clock()).toISOString();
      const createdAt = this.clock().toISOString();
      const payload = sanitize(clean.payload || {}); const metadata = sanitize(clean.metadata || {});
      const payloadJson = JSON.stringify(payload); const metadataJson = JSON.stringify(metadata);
      if (Buffer.byteLength(payloadJson) > 16384 || Buffer.byteLength(metadataJson) > 16384) throw new TypeError('workflow event payload or metadata exceeds 16 KiB');
      const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
      const eventId = clean.eventId || randomUUID();
      const result = this.db.prepare(`INSERT OR IGNORE INTO workflow_events(event_id,event_type,aggregate_type,aggregate_id,correlation_id,causation_id,command_id,occurred_at,source,actor_type,actor_id,payload_json,metadata_json,event_version,dedupe_key,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, clean.eventType, clean.aggregateType, clean.aggregateId, clean.correlationId, clean.causationId || null, clean.commandId || null, occurredAt, clean.source, clean.actorType || null, clean.actorId || null, payloadJson, metadataJson, WORKFLOW_EVENT_VERSION, clean.dedupeKey || null, payloadHash, createdAt);
      if (!result.changes) {
        counters.duplicatesAvoided++;
        const row = clean.dedupeKey ? this.db.prepare('SELECT * FROM workflow_events WHERE dedupe_key=?').get(clean.dedupeKey) : this.db.prepare('SELECT * FROM workflow_events WHERE event_id=?').get(eventId);
        return { event: row, duplicate: true };
      }
      counters.written++;
      return { event: this.db.prepare('SELECT * FROM workflow_events WHERE event_id=?').get(eventId), duplicate: false };
    } catch (error) { counters.rejected++; throw error; }
  }

  metrics() { return { ...counters }; }
  health() {
    const table = this.db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='workflow_events'").get();
    const version = this.db.pragma('user_version', { simple: true });
    return { writable: Boolean(table) && !this.db.readonly, schemaVersion: version, eventVersion: WORKFLOW_EVENT_VERSION, metrics: this.metrics() };
  }
}
