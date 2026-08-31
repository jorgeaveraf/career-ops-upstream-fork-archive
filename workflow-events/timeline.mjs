import { EVENT_STAGE } from './contracts.mjs';

const SUMMARIES = Object.freeze({
  COMMAND_RECEIVED:'Command received.', COMMAND_STARTED:'Command processing started.', COMMAND_COMPLETED:'Command completed.', COMMAND_FAILED:'Command failed.',
  JOB_DECISION_IMPORTED:'Human job decision imported.', JOB_REJECTED:'Job rejected.', JOB_HELD:'Job held for later review.', JOB_NEXT_STAGE_REQUESTED:'Deep preparation requested.',
  ENRICHMENT_QUEUED:'Job preparation queued.', ENRICHMENT_STARTED:'Job research and application preparation started.', ENRICHMENT_COMPLETED:'Job research and application preparation completed.', ENRICHMENT_BLOCKED:'Job preparation is blocked.', ENRICHMENT_FAILED:'Job preparation failed.',
  EVALUATION_COMPLETED:'Deep evaluation completed.', PACKAGE_GENERATED:'Application package generated.', PACKAGE_SUPERSEDED:'Application package superseded.',
  APPLICATION_APPROVED:'Application approved by a human.', APPLICATION_HUMAN_ANSWER_PROVIDED:'A required human answer was provided.', APPLICATION_EXECUTION_STARTED:'Application execution started.', APPLICATION_SUBMIT_ATTEMPTED:'Application submission was attempted.', APPLICATION_NEEDS_HUMAN:'Application paused for a human answer.', APPLICATION_CONFIRMATION_OBSERVED:'Observable application confirmation was correlated.', HUMAN_HANDOFF_CREATED:'An exact human micro-action was prepared.', HUMAN_HANDOFF_RESOLVED:'The human micro-action was completed.', APPLICATION_RESUME_STARTED:'Career Ops started resuming the paused application.', APPLICATION_RESUMED:'Career Ops resumed ownership of the application.', APPLICATION_CONFIRMED:'Application submission confirmed.', APPLICATION_MOVED_TO_APPLICATIONS:'Confirmed application became authoritative in APPLICATIONS.', APPLICATION_VERIFICATION_UNKNOWN:'Submission was attempted but external confirmation could not be verified.', APPLICATION_FAILED:'Application execution failed.', APPLICATION_CANCELLED:'Application execution cancelled.', APPLICATION_HUMAN_CONFIRMED:'A human authoritatively confirmed the application.', APPLICATION_HUMAN_NOT_APPLIED:'A human authoritatively confirmed the application was not submitted.', APPLICATION_VERIFICATION_RETAINED:'A human kept the protected verification ambiguity open.', APPLICATION_FOLLOW_UP_UPDATED:'A human updated application follow-up.',
  COMMUNITY_DISCOVERED:'Community discovered.', COMMUNITY_DECISION_IMPORTED:'Human community decision imported.', COMMUNITY_JOIN_REQUESTED:'Community join requested.', COMMUNITY_JOIN_CONFIRMED:'Community membership confirmed.', COMMUNITY_JOIN_PENDING:'Community join is pending.', COMMUNITY_NEEDS_HUMAN:'Community action needs human attention.', COMMUNITY_SUPPRESSED:'Community suppressed.', COMMUNITY_MONITORING_COMPLETED:'Community monitoring completed.',
  SHEET_SYNC_STARTED:'Sheet synchronization started.', SHEET_SYNC_COMPLETED:'Sheet synchronization completed.', SHEET_SYNC_FAILED:'Sheet synchronization failed.',
  OPERATIONAL_RUN_STARTED:'Operational run started.', OPERATIONAL_RUN_COMPLETED:'Operational run completed.', OPERATIONAL_RUN_PARTIAL:'Operational run completed partially.', OPERATIONAL_RUN_FAILED:'Operational run failed.', WORKFLOW_TIMELINE_BASELINED:'Current workflow state baselined.',
});

function parse(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }
function normalize(row) {
  const payload = parse(row.payload_json); const metadata = parse(row.metadata_json);
  return { timestamp:row.occurred_at, eventId:row.event_id, eventType:row.event_type, stage:EVENT_STAGE[row.event_type] || 'SYSTEM', status:payload.status || payload.toStatus || null, summary:SUMMARIES[row.event_type] || row.event_type.replaceAll('_',' ').toLowerCase(), source:row.source, correlationId:row.correlation_id, causationId:row.causation_id, commandId:row.command_id, refs:{ aggregateType:row.aggregate_type, aggregateId:row.aggregate_id, ...(metadata.refs || {}) }, payload };
}

export class WorkflowTimelineService {
  constructor({ db } = {}) { if (!db) throw new TypeError('db is required'); this.db = db; }
  _all(sql, ...params) { return this.db.prepare(sql).all(...params).map(normalize); }
  getByCorrelation(id) { return this._all('SELECT * FROM workflow_events WHERE correlation_id=? ORDER BY occurred_at,rowid', String(id)); }
  getForJob(id) { return this._all(`SELECT * FROM workflow_events WHERE (aggregate_type='JOB' AND aggregate_id=?) OR json_extract(metadata_json,'$.refs.jobId')=? ORDER BY occurred_at,rowid`, String(id), String(id)); }
  getForApplication(id) { return this._all(`SELECT * FROM workflow_events WHERE (aggregate_type='APPLICATION' AND aggregate_id=?) OR json_extract(metadata_json,'$.refs.applicationId')=? OR json_extract(metadata_json,'$.refs.jobId')=? ORDER BY occurred_at,rowid`, String(id), String(id), String(id)); }
  getForCommunity(id) { return this._all("SELECT * FROM workflow_events WHERE aggregate_type='COMMUNITY' AND aggregate_id=? ORDER BY occurred_at,rowid", String(id)); }
  getRecent(limit = 50) { const bounded=Math.max(1,Math.min(1000,Number(limit)||50)); return this._all('SELECT * FROM (SELECT rowid,* FROM workflow_events ORDER BY occurred_at DESC,rowid DESC LIMIT ?) ORDER BY occurred_at,rowid', bounded); }
}
