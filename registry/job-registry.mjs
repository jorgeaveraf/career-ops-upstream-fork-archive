import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { withProviderQualityMetrics } from '../research/provider-quality.mjs';
import { canonicalHumanDecision, HUMAN_DECISION_LIFECYCLE_VERSION } from '../human-decision/contracts.mjs';
import { derivePreferenceSignals } from '../human-decision/rejection-intelligence.mjs';
import { APPLICATION_ENRICHMENT_VERSION, ENRICHMENT_TRANSITIONS } from '../application-enrichment/contracts.mjs';
import { isEnrichmentCompletionRecord } from '../application-enrichment/completion.mjs';
import { validateApplicationReadiness } from '../application-enrichment/readiness.mjs';
import { WorkflowEventWriter, workflowEventContext } from '../workflow-events/writer.mjs';
import { WorkflowTimelineService } from '../workflow-events/timeline.mjs';
import { WorkflowStatusService } from '../workflow-status/service.mjs';
import { NotificationOutboxService } from '../notifications/outbox.mjs';
import { readOperationalSummary } from '../operational-intelligence/repository.mjs';
import { notificationPreferencesFromEnv } from '../notifications/preferences.mjs';
import { deriveHumanAttentionItems } from '../human-attention/service.mjs';
import {
  canonicalizeJobUrl,
  hashContent,
  hashStable,
  inferExternalJobId,
  normalizeJobCompany,
  normalizeJobLocation,
  normalizeJobTitle,
  normalizeProviderId,
  observationSnapshotHash,
} from '../acquisition/normalize.mjs';

export const DEFAULT_REGISTRY_PATH = 'data/career.db';
export const CURRENT_SCHEMA_VERSION = 35;
export const RUN_STATUSES = Object.freeze([
  'PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'INTERRUPTED',
]);
const TERMINAL_RUN_STATUSES = new Set(['SUCCESS', 'PARTIAL', 'FAILED', 'INTERRUPTED']);

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
const VALID_EXTRACTION = new Set(['direct', 'parsed', 'normalized', 'inferred', 'legacy_import']);
const VALID_CANDIDATE_STATES = new Set(['ACTIVE', 'CARRYOVER', 'EXPIRED', 'DISCARDED', 'ACTED', 'SUPERSEDED']);
const VALID_FILTER_OUTCOMES = new Set(['PASS', 'REJECT', 'UNKNOWN']);
const VALID_RESEARCH_NEED_TYPES = new Set([
  'FETCH_FULL_DESCRIPTION', 'CONFIRM_MEXICO_ELIGIBILITY', 'CONFIRM_REMOTE_SCOPE',
  'CONFIRM_EMPLOYMENT_MODEL', 'CONFIRM_COMPENSATION', 'CONFIRM_COMPANY_MARKET',
  'CONFIRM_SCHEDULE', 'RESOLVE_LOCATION_CONFLICT', 'CONFIRM_POSTING_IS_REAL',
]);
const VALID_RESEARCH_NEED_STATES = new Set(['OPEN', 'RESOLVED', 'OBSOLETE', 'BLOCKED']);
const VALID_SEMANTIC_STAGES = new Set([
  'RAW_DISCOVERED', 'NORMALIZED', 'UNIQUE_JOBS',
  'FILTER_PASS', 'FILTER_REJECT', 'FILTER_UNKNOWN', 'ACTIVE_SET',
  'ELIGIBILITY_ELIGIBLE', 'ELIGIBILITY_INELIGIBLE', 'ELIGIBILITY_UNKNOWN',
  'RANKED', 'TOP_10', 'DEEP_EVALUATED', 'PACKAGE_READY',
]);

function json(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

function requiredText(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

function iso(value, name) {
  const raw = requiredText(value, name);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be an ISO timestamp`);
  return date.toISOString();
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => /^\d{3}_.+\.sql$/.test(name))
    .sort()
    .map(name => ({
      name,
      version: Number.parseInt(name.slice(0, 3), 10),
      sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

function applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
  const files = migrationFiles();
  const latestKnown = files.at(-1)?.version ?? 0;
  const newer = [...applied].filter(version => version > latestKnown);
  if (newer.length > 0) {
    throw new Error(`registry schema ${Math.max(...newer)} is newer than supported schema ${latestKnown}`);
  }
  for (const migration of files) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

/**
 * The only canonical SQLite persistence boundary. Providers return data to the
 * scanner and never receive this object or a raw database connection.
 */
export class JobRegistry {
  constructor({ dbPath = process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH, clock = () => new Date(), env = process.env } = {}) {
    this.dbPath = dbPath;
    this.clock = clock;
    this.env = env;
    if (dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL');
    applyMigrations(this.db);
    this.workflowEvents = new WorkflowEventWriter({ db: this.db, clock: this.clock });
    this.notificationOutbox = new NotificationOutboxService({db:this.db,eventWriter:this.workflowEvents,preferences:notificationPreferencesFromEnv(env),clock:this.clock,sheetUrl:env.CAREER_OPS_DASHBOARD_URL||(env.CAREER_OPS_SHEET_ID?`https://docs.google.com/spreadsheets/d/${env.CAREER_OPS_SHEET_ID}/edit`:'')});
    this.timeline = new WorkflowTimelineService({ db: this.db });
    this._recordOne = this.db.transaction((runId, observation) => this._recordObservation(runId, observation));
    this._recordMany = this.db.transaction((runId, observations) => observations.map(item => this._recordObservation(runId, item)));
  }

  now() {
    return this.clock().toISOString();
  }

  upsertWorkerWorkItem({workKey,workType,workerName,aggregateType,aggregateId,jobId=null,status='QUEUED',dueAt=null,detail={}}={}) {
    const now=this.now(),key=requiredText(workKey,'workKey'),type=requiredText(workType,'workType').toUpperCase();
    this.db.prepare(`INSERT INTO worker_work_items(id,work_key,work_type,worker_name,aggregate_type,aggregate_id,job_id,status,queued_at,due_at,detail_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(work_key) DO UPDATE SET due_at=COALESCE(excluded.due_at,worker_work_items.due_at),detail_json=excluded.detail_json,updated_at=excluded.updated_at`).run(
      `work-${hashStable(key)}`,key,type,requiredText(workerName,'workerName'),requiredText(aggregateType,'aggregateType'),requiredText(aggregateId,'aggregateId'),jobId,status,now,dueAt,json(detail),now,now);
    return this.getWorkerWorkItem(key);
  }
  getWorkerWorkItem(workKey){return this._workerWorkItemRow(this.db.prepare('SELECT * FROM worker_work_items WHERE work_key=?').get(requiredText(workKey,'workKey')));}
  _workerWorkItemRow(r){return r?{id:r.id,workKey:r.work_key,workType:r.work_type,workerName:r.worker_name,aggregateType:r.aggregate_type,aggregateId:r.aggregate_id,jobId:r.job_id,status:r.status,queuedAt:r.queued_at,wakeRequestedAt:r.wake_requested_at,claimedAt:r.claimed_at,completedAt:r.completed_at,dueAt:r.due_at,attemptCount:r.attempt_count,lastErrorCode:r.last_error_code,detail:JSON.parse(r.detail_json||'{}'),createdAt:r.created_at,updatedAt:r.updated_at}:null;}
  listWorkerWorkItems({workType=null,statuses=null}={}){let sql='SELECT * FROM worker_work_items WHERE (? IS NULL OR work_type=?)',args=[workType,workType];if(statuses?.length){sql+=` AND status IN (${statuses.map(()=>'?').join(',')})`;args.push(...statuses);}sql+=' ORDER BY queued_at,id';return this.db.prepare(sql).all(...args).map(r=>this._workerWorkItemRow(r));}
  markWorkerWorkItem(workKey,status,{errorCode=null,detail=null}={}){const now=this.now(),next=requiredText(status,'status').toUpperCase(),timestampColumn={WORKING:'claimed_at',COMPLETED:'completed_at',FAILED:'completed_at',CANCELLED:'completed_at'}[next];const timestampSql=timestampColumn?`,${timestampColumn}=COALESCE(${timestampColumn},?)`:'';const args=[next];if(timestampColumn)args.push(now);args.push(errorCode,detail?json(detail):null,now,workKey);this.db.prepare(`UPDATE worker_work_items SET status=?${timestampSql},attempt_count=attempt_count+${next==='WORKING'?1:0},last_error_code=?,detail_json=COALESCE(?,detail_json),updated_at=? WHERE work_key=?`).run(...args);return this.getWorkerWorkItem(workKey);}
  recordWorkerWakeAttempt({workerName,workType,result,queueDepth=0,processState='',launchAgentLabel='',errorCode=null,evidence={}}={}){const now=this.now(),id=randomUUID();this.db.prepare(`INSERT INTO worker_wake_attempts(id,worker_name,work_type,result,queue_depth,process_state,launch_agent_label,error_code,evidence_json,requested_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,workerName,workType,result,queueDepth,processState,launchAgentLabel,errorCode,json(evidence),now);this.db.prepare("UPDATE worker_work_items SET wake_requested_at=COALESCE(wake_requested_at,?),updated_at=? WHERE work_type=? AND status='QUEUED'").run(now,now,workType);return{id,workerName,workType,result,queueDepth,processState,launchAgentLabel,errorCode,evidence,requestedAt:now};}

  recordWorkflowEvent(event) { const result=this.workflowEvents.append(event);if(!result.duplicate&&String(this.env.CAREER_OPS_NOTIFICATIONS_ENABLED).toLowerCase()==='true'){try{this.notificationOutbox.capture(result.event);}catch(error){this._notificationCaptureError={code:error.code||'NOTIFICATION_CAPTURE_FAILED',message:error.message};}}return result; }
  getWorkflowEventHealth() { return this.workflowEvents.health(); }
  getWorkflowEventMetrics() { return this.workflowEvents.metrics(); }
  _eventCorrelationForRef(ref, fallback) {
    return this.db.prepare("SELECT correlation_id FROM workflow_events WHERE json_extract(metadata_json,'$.refs.humanActionId')=? ORDER BY occurred_at LIMIT 1").get(ref)?.correlation_id || fallback;
  }
  _eventCorrelationForJob(jobId, fallback) {
    return this.db.prepare("SELECT correlation_id FROM workflow_events WHERE aggregate_type='JOB' AND aggregate_id=? OR json_extract(metadata_json,'$.refs.jobId')=? ORDER BY occurred_at DESC LIMIT 1").get(jobId,jobId)?.correlation_id || fallback;
  }

  getSchemaVersion() {
    return this.db.pragma('user_version', { simple: true });
  }

  startOperationalRun({ id = randomUUID(), startedAt = this.now() } = {}) {
    const runId = requiredText(id, 'operational run id');
    const existing = this.db.prepare('SELECT * FROM operational_runs WHERE id = ?').get(runId);
    if (existing) return { ...this._operationalRunRow(existing), existing: true };
    const at = iso(startedAt, 'startedAt');
    this.db.prepare(`INSERT INTO operational_runs(
      id, status, started_at, created_at, updated_at
    ) VALUES (?, 'RUNNING', ?, ?, ?)`)
      .run(runId, at, at, at);
    this.recordWorkflowEvent({eventType:'OPERATIONAL_RUN_STARTED',aggregateType:'OPERATIONAL_RUN',aggregateId:runId,correlationId:runId,causationId:runId,occurredAt:at,source:'daily_core',actorType:'SYSTEM',payload:{status:'RUNNING'},metadata:{refs:{runId}},dedupeKey:`operational-run:${runId}:started`});
    return this.getOperationalRun(runId);
  }

  finishOperationalRun(id, {
    status, discoveryRunId = null, finishedAt = this.now(), summary = {}, errors = [],
    jobsFound = 0, eligible = 0, shortlisted = 0, evaluationsCompleted = 0,
    packagesReady = 0, sheetSynced = false, notificationRequired = false, notificationSent = false,
  } = {}) {
    const runId = requiredText(id, 'operational run id');
    const next = requiredText(status, 'operational status').toUpperCase();
    if (!['SUCCESS', 'PARTIAL', 'FAILED'].includes(next)) throw new TypeError('invalid terminal operational status');
    const current = this.db.prepare('SELECT * FROM operational_runs WHERE id = ?').get(runId);
    if (!current) throw new Error(`unknown operational run: ${runId}`);
    if (current.status !== 'RUNNING') return { ...this._operationalRunRow(current), existing: true };
    const at = iso(finishedAt, 'finishedAt');
    this.db.prepare(`UPDATE operational_runs SET
      discovery_run_id = ?, status = ?, finished_at = ?, summary_json = ?, errors_json = ?,
      jobs_found = ?, eligible = ?, shortlisted = ?, evaluations_completed = ?, packages_ready = ?,
      sheet_synced = ?, notification_required = ?, notification_sent = ?, updated_at = ?
      WHERE id = ?`)
      .run(discoveryRunId, next, at, json(summary), json(errors, []), Number(jobsFound) || 0,
        Number(eligible) || 0, Number(shortlisted) || 0, Number(evaluationsCompleted) || 0,
        Number(packagesReady) || 0, sheetSynced ? 1 : 0, notificationRequired ? 1 : 0,
        notificationSent ? 1 : 0, at, runId);
    this.recordWorkflowEvent({eventType:next==='SUCCESS'?'OPERATIONAL_RUN_COMPLETED':next==='PARTIAL'?'OPERATIONAL_RUN_PARTIAL':'OPERATIONAL_RUN_FAILED',aggregateType:'OPERATIONAL_RUN',aggregateId:runId,correlationId:runId,causationId:this.db.prepare("SELECT event_id FROM workflow_events WHERE dedupe_key=?").get(`operational-run:${runId}:started`)?.event_id||runId,occurredAt:at,source:'daily_core',actorType:'SYSTEM',payload:{status:next,counts:{jobsFound,eligible,shortlisted,evaluationsCompleted,packagesReady}},metadata:{refs:{runId,discoveryRunId}},dedupeKey:`operational-run:${runId}:finished`});
    return this.getOperationalRun(runId);
  }

  _operationalRunRow(row) {
    if (!row) return null;
    return {
      id: row.id, discoveryRunId: row.discovery_run_id, status: row.status,
      startedAt: row.started_at, finishedAt: row.finished_at,
      summary: JSON.parse(row.summary_json || '{}'), errors: JSON.parse(row.errors_json || '[]'),
      jobsFound: row.jobs_found, eligible: row.eligible, shortlisted: row.shortlisted,
      evaluationsCompleted: row.evaluations_completed, packagesReady: row.packages_ready,
      sheetSynced: Boolean(row.sheet_synced), notificationRequired: Boolean(row.notification_required),
      notificationSent: Boolean(row.notification_sent), createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  getOperationalRun(id) {
    return this._operationalRunRow(this.db.prepare('SELECT * FROM operational_runs WHERE id = ?')
      .get(requiredText(id, 'operational run id')));
  }

  getLatestOperationalRun() {
    return this._operationalRunRow(this.db.prepare('SELECT * FROM operational_runs ORDER BY started_at DESC, rowid DESC LIMIT 1').get());
  }

  getLatestDailyOperationalRun() {
    return this._operationalRunRow(this.db.prepare("SELECT * FROM operational_runs WHERE discovery_run_id IS NOT NULL AND status IN ('SUCCESS','PARTIAL','FAILED') ORDER BY started_at DESC, rowid DESC LIMIT 1").get());
  }

  getLatestRunByType(type) {
    const row = this.db.prepare('SELECT id FROM runs WHERE type = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
      .get(requiredText(type, 'run type'));
    return row ? this.getRun(row.id) : null;
  }

  recordBrowserResearchResults(runId, observations = []) {
    const run = this.getRun(requiredText(runId, 'runId'));
    if (!run || run.status !== 'RUNNING') throw new Error(`browser research run ${runId} is not RUNNING`);
    return this.db.transaction(items => items.map(item => {
      const key = requiredText(item.observationKey, 'observationKey');
      const existing = this.db.prepare('SELECT * FROM browser_research_observations WHERE observation_key = ?').get(key);
      const at = iso(item.retrievedAt, 'retrievedAt');
      let id; let outcome;
      if (existing) {
        id = existing.id; outcome = 'DUPLICATE';
        this.db.prepare('UPDATE browser_research_observations SET last_retrieved_at = ?, occurrences = occurrences + 1, updated_at = ? WHERE id = ?').run(at, this.now(), id);
      } else {
        id = randomUUID(); outcome = 'NEW';
        this.db.prepare(`INSERT INTO browser_research_observations(
          id, observation_key, entity_type, source, source_url, confidence, extraction_method,
          data_json, evidence_json, provenance_json, first_retrieved_at, last_retrieved_at,
          occurrences, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
          .run(id, key, requiredText(item.entityType, 'entityType'), requiredText(item.source, 'source'),
            requiredText(item.sourceUrl, 'sourceUrl'), requiredText(item.confidence, 'confidence'),
            requiredText(item.extractionMethod, 'extractionMethod'), json(item.data || {}), json(item.evidence, []),
            json(item.provenance || {}), at, at, this.now(), this.now());
      }
      this.db.prepare(`INSERT INTO browser_research_run_observations(run_id, observation_id, outcome, recorded_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(run_id, observation_id) DO UPDATE SET outcome = 'DUPLICATE', recorded_at = excluded.recorded_at`)
        .run(runId, id, outcome, this.now());
      return { id, observationKey: key, entityType: item.entityType, outcome, existing: Boolean(existing) };
    }))(observations);
  }

  listBrowserResearchEvidence({ entityType = null, source = null, limit = 100 } = {}) {
    const bounded = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 100));
    return this.db.prepare(`SELECT * FROM browser_research_observations
      WHERE (? IS NULL OR entity_type = ?) AND (? IS NULL OR source = ?)
      ORDER BY last_retrieved_at DESC, id LIMIT ?`)
      .all(entityType, entityType, source, source, bounded).map(row => ({
        id: row.id, observationKey: row.observation_key, entityType: row.entity_type,
        source: row.source, sourceUrl: row.source_url, confidence: row.confidence,
        extractionMethod: row.extraction_method, data: JSON.parse(row.data_json),
        evidence: JSON.parse(row.evidence_json), provenance: JSON.parse(row.provenance_json),
        firstRetrievedAt: row.first_retrieved_at, lastRetrievedAt: row.last_retrieved_at, occurrences: row.occurrences,
      }));
  }

  listResearchCompanies(limit = 20) {
    const bounded = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 20));
    return this.db.prepare('SELECT DISTINCT canonical_company company FROM jobs ORDER BY canonical_company LIMIT ?').all(bounded).map(row => row.company);
  }

  recordBrowserDiscoveryMetrics(runId, metrics = []) {
    const run = this.getRun(requiredText(runId, 'runId'));
    if (!run) throw new Error(`unknown browser discovery run: ${runId}`);
    return this.db.transaction(items => items.map(item => {
      this.db.prepare(`INSERT INTO browser_discovery_metrics(
        run_id, provider, jobs_found, jobs_valid, jobs_duplicate, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider) DO UPDATE SET
        jobs_found = excluded.jobs_found, jobs_valid = excluded.jobs_valid,
        jobs_duplicate = excluded.jobs_duplicate, recorded_at = excluded.recorded_at`)
        .run(runId, requiredText(item.provider, 'provider'), Number(item.discovered) || 0,
          Number(item.valid) || 0, Number(item.duplicates) || 0, this.now());
      return this.getBrowserDiscoveryMetrics(runId).find(row => row.provider === item.provider);
    }))(metrics);
  }

  recordBrowserDiscoveryTaskResult(runId, item, observations = []) {
    const id = requiredText(runId, 'runId');
    if (!this.getRun(id)) throw new Error(`unknown browser discovery run: ${id}`);
    const status = requiredText(item?.status, 'task status').toUpperCase();
    if (!['SUCCESS', 'FAILED'].includes(status)) throw new TypeError('task status must be SUCCESS or FAILED');
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO browser_discovery_task_results(
        run_id, task_id, provider, strategy_id, query, status, jobs_found, jobs_valid,
        jobs_rejected, jobs_duplicate, explanation_json, error_code, error_message, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, task_id) DO UPDATE SET
        status = excluded.status, jobs_found = excluded.jobs_found, jobs_valid = excluded.jobs_valid,
        jobs_rejected = excluded.jobs_rejected, jobs_duplicate = excluded.jobs_duplicate,
        explanation_json = excluded.explanation_json, error_code = excluded.error_code,
        error_message = excluded.error_message, started_at = excluded.started_at, finished_at = excluded.finished_at`)
        .run(id, requiredText(item.taskId, 'taskId'), requiredText(item.provider, 'provider'),
          requiredText(item.strategyId, 'strategyId'), String(item.query || ''), status,
          Number(item.discovered) || 0, Number(item.valid) || 0, Number(item.rejected) || 0,
          Number(item.duplicates) || 0, json(item.explanation || {}), item.errorCode || null,
          item.errorMessage || null, iso(item.startedAt, 'startedAt'), iso(item.finishedAt, 'finishedAt'));
      const link = this.db.prepare(`INSERT INTO browser_discovery_task_observations(run_id, task_id, observation_id, outcome)
        VALUES (?, ?, ?, ?) ON CONFLICT(run_id, task_id, observation_id) DO UPDATE SET outcome = excluded.outcome`);
      for (const observation of observations) link.run(id, item.taskId, requiredText(observation.observationId, 'observationId'), requiredText(observation.outcome, 'outcome'));
      return this.db.prepare('SELECT * FROM browser_discovery_task_results WHERE run_id = ? AND task_id = ?').get(id, item.taskId);
    })();
  }

  getBrowserDiscoveryTaskResults(runId) {
    return this.db.prepare(`SELECT task_id, provider, strategy_id, query, status, jobs_found,
      jobs_valid, jobs_rejected, jobs_duplicate, explanation_json, error_code, error_message,
      started_at, finished_at FROM browser_discovery_task_results
      WHERE run_id = ? ORDER BY provider, strategy_id, query, task_id`)
      .all(requiredText(runId, 'runId')).map(row => ({
        taskId: row.task_id, provider: row.provider, strategy: row.strategy_id, query: row.query,
        status: row.status, discovered: row.jobs_found, valid: row.jobs_valid,
        rejected: row.jobs_rejected, duplicates: row.jobs_duplicate,
        explanation: JSON.parse(row.explanation_json || '{}'), errorCode: row.error_code,
        errorMessage: row.error_message, startedAt: row.started_at, finishedAt: row.finished_at,
        durationMs: Math.max(0, new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()),
      }));
  }

  recordBrowserTaskTelemetry(runId, telemetry, { mode = 'DISCOVERY' } = {}) {
    const id = requiredText(runId, 'runId');
    if (!this.getRun(id)) throw new Error(`unknown browser run: ${id}`);
    const taskMode = requiredText(mode, 'browser task mode').toUpperCase();
    if (!['DISCOVERY', 'ENRICHMENT'].includes(taskMode)) throw new TypeError('browser task mode must be DISCOVERY or ENRICHMENT');
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO browser_task_telemetry(
        run_id, task_id, mode, source, strategy_id, planned_url, final_url, page_title,
        page_classification, auth_observed, expected_selector, selectors_version, readiness_ms,
        time_to_first_results_ms, scroll_passes, cards_seen, unique_cards, extracted_records,
        detail_pages_opened, descriptions_acquired, duplicates, outcome, phase_durations_json, state_history_json,
        warnings_json, errors_json, started_at, finished_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, task_id) DO UPDATE SET final_url=excluded.final_url, page_title=excluded.page_title,
        page_classification=excluded.page_classification, auth_observed=excluded.auth_observed,
        time_to_first_results_ms=excluded.time_to_first_results_ms, scroll_passes=excluded.scroll_passes,
        cards_seen=excluded.cards_seen, unique_cards=excluded.unique_cards, extracted_records=excluded.extracted_records,
        detail_pages_opened=excluded.detail_pages_opened, descriptions_acquired=excluded.descriptions_acquired, duplicates=excluded.duplicates, outcome=excluded.outcome,
        phase_durations_json=excluded.phase_durations_json, state_history_json=excluded.state_history_json,
        warnings_json=excluded.warnings_json, errors_json=excluded.errors_json, finished_at=excluded.finished_at,
        duration_ms=excluded.duration_ms`)
        .run(id, requiredText(telemetry.taskId, 'taskId'), taskMode, requiredText(telemetry.source, 'source'),
          requiredText(telemetry.strategyId, 'strategyId'), requiredText(telemetry.plannedUrl, 'plannedUrl'), telemetry.finalUrl || null,
          telemetry.title || null, telemetry.pageClassification || 'UNKNOWN', telemetry.authObserved ? 1 : 0,
          telemetry.expectedSelector || null, telemetry.selectorsVersion || null, telemetry.readinessMs ?? null,
          telemetry.timeToFirstResultsMs ?? null, telemetry.scrollPasses?.length || 0, Number(telemetry.cardsSeen) || 0,
          Number(telemetry.uniqueCards) || 0, Number(telemetry.extractedRecords) || 0,
          Number(telemetry.detailPagesOpened) || 0, Number(telemetry.descriptionsAcquired) || 0, Number(telemetry.duplicates) || 0,
          requiredText(telemetry.outcome, 'browser outcome'), json(telemetry.phaseDurationsMs), json(telemetry.states, []),
          json(telemetry.warnings, []), json(telemetry.errors, []), iso(telemetry.startedAt, 'startedAt'),
          iso(telemetry.finishedAt, 'finishedAt'), Number(telemetry.durationMs) || 0);
      this.db.prepare('DELETE FROM browser_scroll_pass_telemetry WHERE run_id = ? AND task_id = ?').run(id, telemetry.taskId);
      const insert = this.db.prepare(`INSERT INTO browser_scroll_pass_telemetry(run_id, task_id, pass, cards_before, cards_after, unique_added, result_fingerprint, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of telemetry.scrollPasses || []) insert.run(id, telemetry.taskId, item.pass, item.cardsBefore, item.cardsAfter, item.uniqueAdded, item.fingerprint || null, iso(item.at, 'scroll recordedAt'));
      return this.getBrowserTaskTelemetry(id).find(item => item.taskId === telemetry.taskId);
    })();
  }

  getBrowserTaskTelemetry(runId = null, { mode = null } = {}) {
    return this.db.prepare(`SELECT * FROM browser_task_telemetry WHERE (? IS NULL OR run_id = ?) AND (? IS NULL OR mode = ?) ORDER BY started_at, task_id`)
      .all(runId, runId, mode, mode).map(row => ({
        runId: row.run_id, taskId: row.task_id, mode: row.mode, source: row.source, strategyId: row.strategy_id,
        plannedUrl: row.planned_url, finalUrl: row.final_url, title: row.page_title,
        pageClassification: row.page_classification, authObserved: Boolean(row.auth_observed),
        expectedSelector: row.expected_selector, selectorsVersion: row.selectors_version,
        timeToFirstResultsMs: row.time_to_first_results_ms, scrollPasses: row.scroll_passes,
        cardsSeen: row.cards_seen, uniqueCards: row.unique_cards, extractedRecords: row.extracted_records,
        detailPagesOpened: row.detail_pages_opened, descriptionsAcquired: row.descriptions_acquired, duplicates: row.duplicates, outcome: row.outcome,
        phaseDurationsMs: JSON.parse(row.phase_durations_json), states: JSON.parse(row.state_history_json),
        warnings: JSON.parse(row.warnings_json), errors: JSON.parse(row.errors_json),
        startedAt: row.started_at, finishedAt: row.finished_at, durationMs: row.duration_ms,
      }));
  }

  getBrowserObservabilityReport({ runId = null } = {}) {
    const tasks = this.getBrowserTaskTelemetry(runId);
    const count = key => Object.fromEntries([...new Set(tasks.map(item => item[key]))].sort().map(value => [value, tasks.filter(item => item[key] === value).length]));
    const successes = tasks.filter(item => ['SUCCESS_RESULTS', 'SUCCESS_EMPTY'].includes(item.outcome));
    return { runId, tasks: tasks.length, semanticSuccesses: successes.length,
      semanticSuccessRate: tasks.length ? Number((successes.length / tasks.length).toFixed(4)) : 0,
      resultsTasks: tasks.filter(item => item.outcome === 'SUCCESS_RESULTS').length,
      emptyTasks: tasks.filter(item => item.outcome === 'SUCCESS_EMPTY').length,
      outcomes: count('outcome'), classifications: count('pageClassification'),
      cardsSeen: tasks.reduce((sum, item) => sum + item.cardsSeen, 0),
      uniqueCards: tasks.reduce((sum, item) => sum + item.uniqueCards, 0),
      extractedRecords: tasks.reduce((sum, item) => sum + item.extractedRecords, 0),
      detailsOpened: tasks.reduce((sum, item) => sum + item.detailPagesOpened, 0),
      descriptionsAcquired: tasks.reduce((sum, item) => sum + item.descriptionsAcquired, 0), tasksDetail: tasks };
  }

  getBrowserDiscoveryStrategyMetrics(runId) {
    const id = requiredText(runId, 'runId');
    return this.db.prepare(`SELECT t.provider, t.strategy_id,
      SUM(t.jobs_found) discovered, SUM(t.jobs_valid) valid, SUM(t.jobs_rejected) rejected,
      SUM(t.jobs_duplicate) duplicates, MIN(t.started_at) started_at, MAX(t.finished_at) finished_at,
      (SELECT COUNT(DISTINCT a.job_id) FROM browser_discovery_task_observations x
        JOIN job_assessments a ON a.observation_id = x.observation_id
        JOIN browser_discovery_task_results tx ON tx.run_id = x.run_id AND tx.task_id = x.task_id
        WHERE x.run_id = t.run_id AND tx.provider = t.provider AND tx.strategy_id = t.strategy_id AND a.eligibility_status = 'ELIGIBLE') eligible,
      (SELECT COUNT(DISTINCT a.job_id) FROM browser_discovery_task_observations x
        JOIN job_assessments a ON a.observation_id = x.observation_id
        JOIN browser_discovery_task_results tx ON tx.run_id = x.run_id AND tx.task_id = x.task_id
        WHERE x.run_id = t.run_id AND tx.provider = t.provider AND tx.strategy_id = t.strategy_id AND a.decision = 'SHORTLIST') shortlist,
      (SELECT COUNT(DISTINCT e.job_id) FROM browser_discovery_task_observations x
        JOIN job_evaluations e ON e.observation_id = x.observation_id
        JOIN browser_discovery_task_results tx ON tx.run_id = x.run_id AND tx.task_id = x.task_id
        WHERE x.run_id = t.run_id AND tx.provider = t.provider AND tx.strategy_id = t.strategy_id AND e.status = 'VALID') evaluations,
      (SELECT COUNT(DISTINCT p.job_id) FROM browser_discovery_task_observations x
        JOIN job_evaluations e ON e.observation_id = x.observation_id
        JOIN application_packages p ON p.evaluation_id = e.id
        JOIN browser_discovery_task_results tx ON tx.run_id = x.run_id AND tx.task_id = x.task_id
        WHERE x.run_id = t.run_id AND tx.provider = t.provider AND tx.strategy_id = t.strategy_id AND p.validation_status = 'VALID') packages_ready
      FROM browser_discovery_task_results t WHERE t.run_id = ?
      GROUP BY t.run_id, t.provider, t.strategy_id ORDER BY t.provider, t.strategy_id`).all(id).map(row => withProviderQualityMetrics({
        provider: row.provider, strategy: row.strategy_id, discovered: row.discovered,
        valid: row.valid, rejected: row.rejected, duplicates: row.duplicates,
        eligible: row.eligible, shortlist: row.shortlist, evaluations: row.evaluations,
        packagesReady: row.packages_ready, startedAt: row.started_at, lastRun: row.finished_at,
        durationMs: Math.max(0, new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()),
      }));
  }

  getBrowserDiscoveryMetrics(runId) {
    const id = requiredText(runId, 'runId');
    return this.db.prepare(`SELECT m.*,
      (SELECT COUNT(DISTINCT a.job_id) FROM run_observations ro
        JOIN job_observations o ON o.id = ro.observation_id
        JOIN job_assessments a ON a.observation_id = o.id
        WHERE ro.run_id = m.run_id AND o.provider = m.provider AND a.eligibility_status = 'ELIGIBLE') jobs_eligible,
      (SELECT COUNT(DISTINCT a.job_id) FROM run_observations ro
        JOIN job_observations o ON o.id = ro.observation_id
        JOIN job_assessments a ON a.observation_id = o.id
        WHERE ro.run_id = m.run_id AND o.provider = m.provider AND a.decision = 'SHORTLIST') jobs_shortlisted,
      (SELECT COUNT(DISTINCT e.job_id) FROM run_observations ro
        JOIN job_observations o ON o.id = ro.observation_id
        JOIN job_evaluations e ON e.observation_id = o.id
        WHERE ro.run_id = m.run_id AND o.provider = m.provider AND e.status = 'VALID') jobs_evaluated,
      (SELECT COUNT(DISTINCT p.job_id) FROM run_observations ro
        JOIN job_observations o ON o.id = ro.observation_id
        JOIN job_evaluations e ON e.observation_id = o.id
        JOIN application_packages p ON p.evaluation_id = e.id
        WHERE ro.run_id = m.run_id AND o.provider = m.provider AND p.validation_status = 'VALID') packages_generated
      FROM browser_discovery_metrics m WHERE m.run_id = ? ORDER BY m.provider`).all(id).map(row => withProviderQualityMetrics({
        provider: row.provider, discovered: row.jobs_found, valid: row.jobs_valid,
        duplicates: row.jobs_duplicate, eligible: row.jobs_eligible, shortlist: row.jobs_shortlisted,
        evaluations: row.jobs_evaluated, packages: row.packages_generated,
        recordedAt: row.recorded_at,
      }));
  }

  getProviderPerformance() {
    const providers = new Map();
    for (const row of this.db.prepare(`SELECT provider, SUM(observations_count) discovered,
      SUM(observations_count) valid, MAX(COALESCE(finished_at, started_at)) last_run
      FROM run_provider_results WHERE provider NOT LIKE 'browser:%' GROUP BY provider`).all()) {
      providers.set(row.provider, { provider: row.provider, discovered: row.discovered || 0, valid: row.valid || 0, duplicates: 0, eligible: 0, shortlist: 0, evaluations: 0, packagesReady: 0, lastRun: row.last_run });
    }
    for (const row of this.db.prepare(`SELECT provider, SUM(jobs_found) discovered,
      SUM(jobs_valid) valid, SUM(jobs_duplicate) duplicates, MAX(recorded_at) last_run
      FROM browser_discovery_metrics GROUP BY provider`).all()) {
      providers.set(row.provider, { provider: row.provider, discovered: row.discovered || 0, valid: row.valid || 0, duplicates: row.duplicates || 0, eligible: 0, shortlist: 0, evaluations: 0, packagesReady: 0, lastRun: row.last_run });
    }
    for (const row of this.db.prepare(`SELECT o.provider,
      COUNT(DISTINCT CASE WHEN ro.outcome = 'DUPLICATE_OBSERVATION' THEN ro.run_id || ':' || ro.observation_id END) duplicates,
      COUNT(DISTINCT CASE WHEN a.eligibility_status = 'ELIGIBLE' THEN a.job_id END) eligible,
      COUNT(DISTINCT CASE WHEN a.decision = 'SHORTLIST' THEN a.job_id END) shortlisted,
      COUNT(DISTINCT CASE WHEN e.status = 'VALID' THEN e.job_id END) evaluated,
      COUNT(DISTINCT CASE WHEN p.validation_status = 'VALID' THEN p.job_id END) packages_ready,
      MAX(o.last_observed_at) last_observed
      FROM job_observations o
      LEFT JOIN run_observations ro ON ro.observation_id = o.id
      LEFT JOIN job_assessments a ON a.observation_id = o.id
      LEFT JOIN job_evaluations e ON e.observation_id = o.id
      LEFT JOIN application_packages p ON p.evaluation_id = e.id
      GROUP BY o.provider`).all()) {
      const current = providers.get(row.provider) || { provider: row.provider, discovered: 0, valid: 0, duplicates: 0, eligible: 0, shortlist: 0, evaluations: 0, packagesReady: 0, lastRun: null };
      if (!row.provider.startsWith('browser:')) current.duplicates = row.duplicates || 0;
      current.eligible = row.eligible || 0; current.shortlist = row.shortlisted || 0;
      current.evaluations = row.evaluated || 0; current.packagesReady = row.packages_ready || 0;
      current.lastRun ||= row.last_observed; providers.set(row.provider, current);
    }
    return [...providers.values()].map(withProviderQualityMetrics)
      .sort((a, b) => b.providerRoi - a.providerRoi || b.discovered - a.discovered || a.provider.localeCompare(b.provider));
  }

  recordNotificationDelivery({
    id = randomUUID(), operationalRunId, channel = 'email', provider, recipient,
    status, subject, error = null, providerMessageId = null, attemptedAt = this.now(), sentAt = null,
  } = {}) {
    const runId = requiredText(operationalRunId, 'operationalRunId');
    if (!this.getOperationalRun(runId)) throw new Error(`unknown operational run: ${runId}`);
    const existing = this.db.prepare('SELECT * FROM notification_deliveries WHERE operational_run_id = ? AND channel = ?')
      .get(runId, requiredText(channel, 'channel'));
    if (existing) return { ...this._notificationDeliveryRow(existing), existing: true };
    const normalizedStatus = requiredText(status, 'notification status').toUpperCase();
    if (!['SENT', 'FAILED', 'SKIPPED'].includes(normalizedStatus)) throw new TypeError('invalid notification status');
    const attempted = iso(attemptedAt, 'attemptedAt');
    const storedStatus=normalizedStatus==='SKIPPED'?'SUPPRESSED':normalizedStatus;
    this.db.prepare(`INSERT INTO notification_deliveries(id,event_id,operational_run_id,aggregate_type,aggregate_id,correlation_id,notification_type,priority,channel,recipient_identity,provider,provider_message_id,status,subject,body_text,template_version,trigger_snapshot_json,error_code,error,attempt_count,max_attempts,next_attempt_at,last_attempt_at,created_at,sent_at,dedupe_key) VALUES(?,NULL,?,'OPERATIONAL_RUN',?,?,'DAILY_SUMMARY','LOW',?,?,?,?,?,?,'','1.0','{}',NULL,?,1,1,NULL,?,?,?,?)`)
      .run(id,runId,runId,runId,channel,requiredText(recipient,'recipient'),requiredText(provider,'provider'),providerMessageId,storedStatus,requiredText(subject,'subject'),error,attempted,attempted,normalizedStatus==='SENT'?iso(sentAt||attempted,'sentAt'):null,`legacy:${runId}:${channel}`);
    this.recordWorkflowEvent({eventType:normalizedStatus==='SENT'?'NOTIFICATION_SENT':normalizedStatus==='FAILED'?'NOTIFICATION_FAILED':'NOTIFICATION_DISABLED',aggregateType:'NOTIFICATION',aggregateId:id,correlationId:runId,causationId:runId,occurredAt:attempted,source:'daily_core',actorType:'SYSTEM',payload:{status:storedStatus,channel},metadata:{refs:{runId,notificationId:id,providerMessageId}},dedupeKey:`notification:${id}:${normalizedStatus}`});
    return this.getNotificationDelivery(runId, channel);
  }

  _notificationDeliveryRow(row) {
    if (!row) return null;
    return {
      id: row.id, operationalRunId: row.operational_run_id, channel: row.channel,
      provider: row.provider, recipient: row.recipient_identity, status: row.status, subject: row.subject,
      error: row.error, providerMessageId: row.provider_message_id,
      attemptedAt: row.last_attempt_at || row.created_at, sentAt: row.sent_at,
    };
  }

  getNotificationDelivery(operationalRunId, channel = 'email') {
    return this._notificationDeliveryRow(this.db.prepare(
      'SELECT * FROM notification_deliveries WHERE operational_run_id = ? AND channel = ?',
    ).get(requiredText(operationalRunId, 'operationalRunId'), requiredText(channel, 'channel')));
  }

  getNotificationIntent(id){return this.notificationOutbox.get(requiredText(id,'notificationId'));}
  listNotificationIntents(options={}){return this.notificationOutbox.list(options);}
  getNotificationMetrics(){return this.notificationOutbox.metrics();}

  createRun({ id = randomUUID(), type = 'scan', createdAt = this.now(), metadata = {}, ownerPid = null } = {}) {
    const runId = requiredText(id, 'run id');
    const existing = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (existing) return { ...existing, existing: true };
    const at = iso(createdAt, 'createdAt');
    this.db.prepare(`
      INSERT INTO runs(
        id, type, legacy_status, status, created_at, started_at, heartbeat_at, owner_pid, metadata_json
      ) VALUES (?, ?, 'running', 'PENDING', ?, ?, ?, ?, ?)
    `).run(runId, requiredText(type, 'run type'), at, at, at, ownerPid, json(metadata));
    return this.getRun(runId);
  }

  startRun({ id = randomUUID(), type = 'scan', startedAt = this.now(), metadata = {}, ownerPid = null } = {}) {
    const runId = requiredText(id, 'run id');
    let run = this.getRun(runId);
    if (!run) {
      this.createRun({ id: runId, type, createdAt: startedAt, metadata, ownerPid });
      run = this.getRun(runId);
    }
    if (run.status === 'RUNNING') return { ...run, existing: true };
    if (run.status !== 'PENDING') throw new Error(`run ${runId} cannot transition from ${run.status} to RUNNING`);
    const at = iso(startedAt, 'startedAt');
    this.db.prepare(`
      UPDATE runs SET status = 'RUNNING', legacy_status = 'running', started_at = ?,
        heartbeat_at = ?, owner_pid = ?, metadata_json = ? WHERE id = ?
    `).run(at, at, ownerPid ?? run.owner_pid, json(metadata), runId);
    return this.getRun(runId);
  }

  heartbeatRun(runId, { at = this.now(), ownerPid } = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (run.status !== 'RUNNING') throw new Error(`cannot heartbeat ${run.status} run: ${runId}`);
    this.db.prepare('UPDATE runs SET heartbeat_at = ?, owner_pid = COALESCE(?, owner_pid) WHERE id = ?')
      .run(iso(at, 'heartbeatAt'), ownerPid ?? null, runId);
    return this.getRun(runId);
  }

  finishRun(runId, { status = 'SUCCESS', finishedAt = this.now(), metadata } = {}) {
    const normalizedStatus = status === 'completed' ? 'SUCCESS' : status === 'failed' ? 'FAILED' : String(status).toUpperCase();
    if (!TERMINAL_RUN_STATUSES.has(normalizedStatus)) {
      throw new TypeError(`run terminal status must be one of ${[...TERMINAL_RUN_STATUSES].join(', ')}`);
    }
    const summary = this._calculateRunSummary(runId);
    const current = this.getRun(runId);
    if (!current) throw new Error(`unknown run: ${runId}`);
    if (TERMINAL_RUN_STATUSES.has(current.status)) return this.getRunSummary(runId);
    this.db.prepare(`
      UPDATE runs SET
        status = ?, legacy_status = ?, finished_at = ?, heartbeat_at = ?, metadata_json = ?,
        observations_count = ?, new_jobs_count = ?, known_jobs_count = ?,
        changed_jobs_count = ?, duplicate_observations_count = ?, failures_count = ?
      WHERE id = ?
    `).run(
      normalizedStatus,
      normalizedStatus === 'FAILED' ? 'failed' : 'completed',
      iso(finishedAt, 'finishedAt'), iso(finishedAt, 'finishedAt'),
      metadata === undefined ? current.metadata_json : json(metadata),
      summary.observations,
      summary.newJobs,
      summary.knownJobs,
      summary.changedJobs,
      summary.duplicateObservations,
      summary.failures,
      runId,
    );
    return this.getRunSummary(runId);
  }

  failRun(runId, error, metadata) {
    const current = this.getRun(runId);
    if (!current) throw new Error(`unknown run: ${runId}`);
    if (TERMINAL_RUN_STATUSES.has(current.status)) return this.getRunSummary(runId);
    this.recordRunFailure(runId, {
      code: 'UPSTREAM_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
    });
    return this.finishRun(runId, { status: 'FAILED', metadata });
  }

  interruptRun(runId, { reason = 'abandoned run recovered', finishedAt = this.now() } = {}) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (run.status !== 'RUNNING') return this.getRunSummary(runId);
    this.recordRunFailure(runId, { code: 'INTERRUPTED', message: reason, retryable: true });
    return this.finishRun(runId, { status: 'INTERRUPTED', finishedAt });
  }

  recoverInterruptedRuns({ now = this.now(), staleAfterMs = 6 * 60 * 60 * 1000, isProcessAlive = defaultIsProcessAlive, excludeRunId = null } = {}) {
    const nowIso = iso(now, 'now');
    const nowMs = new Date(nowIso).getTime();
    const recovered = [];
    for (const run of this.db.prepare("SELECT * FROM runs WHERE status = 'RUNNING' ORDER BY started_at, id").all()) {
      if (run.id === excludeRunId) continue;
      const heartbeatMs = new Date(run.heartbeat_at || run.started_at).getTime();
      const expired = !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > staleAfterMs;
      const ownerGone = !run.owner_pid || !isProcessAlive(run.owner_pid);
      if (!expired && !ownerGone) continue;
      recovered.push(this.interruptRun(run.id, {
        reason: ownerGone ? `owner process ${run.owner_pid || 'unknown'} is not running` : `heartbeat expired after ${staleAfterMs}ms`,
        finishedAt: nowIso,
      }));
    }
    return recovered;
  }

  getRun(runId) {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) || null;
  }

  _calculateRunSummary(runId) {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS observations,
        COALESCE(SUM(CASE WHEN ro.outcome = 'NEW_JOB' THEN 1 ELSE 0 END), 0) AS new_jobs,
        COALESCE(SUM(CASE WHEN ro.outcome != 'NEW_JOB' THEN 1 ELSE 0 END), 0) AS known_jobs,
        COALESCE(SUM(CASE WHEN ro.outcome = 'NEW_OBSERVATION' AND o.content_changed = 1 THEN 1 ELSE 0 END), 0) AS changed_jobs,
        COALESCE(SUM(CASE WHEN ro.outcome = 'DUPLICATE_OBSERVATION' THEN 1 ELSE 0 END), 0) AS duplicate_observations
      FROM run_observations ro
      JOIN job_observations o ON o.id = ro.observation_id
      WHERE ro.run_id = ?
    `).get(runId);
    const failures = this.db.prepare('SELECT COUNT(*) AS count FROM run_failures WHERE run_id = ?').get(runId).count;
    return {
      observations: counts.observations,
      newJobs: counts.new_jobs,
      knownJobs: counts.known_jobs,
      changedJobs: counts.changed_jobs,
      duplicateObservations: counts.duplicate_observations,
      failures,
    };
  }

  getRunSummary(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    const calculated = TERMINAL_RUN_STATUSES.has(run.status) ? null : this._calculateRunSummary(runId);
    return {
      id: run.id,
      type: run.type,
      status: run.status,
      createdAt: run.created_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      durationMs: run.finished_at ? Math.max(0, new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) : null,
      observations: calculated?.observations ?? run.observations_count,
      newJobs: calculated?.newJobs ?? run.new_jobs_count,
      knownJobs: calculated?.knownJobs ?? run.known_jobs_count,
      changedJobs: calculated?.changedJobs ?? run.changed_jobs_count,
      duplicateObservations: calculated?.duplicateObservations ?? run.duplicate_observations_count,
      failures: calculated?.failures ?? run.failures_count,
      providerResults: this.getProviderResults(runId),
      failureDetails: this.getRunFailures(runId),
      browserDiscoveryMetrics: run.type === 'browser-discovery' ? this.getBrowserDiscoveryMetrics(runId) : undefined,
      browserDiscoveryTaskResults: run.type === 'browser-discovery' ? this.getBrowserDiscoveryTaskResults(runId) : undefined,
      browserDiscoveryStrategyMetrics: run.type === 'browser-discovery' ? this.getBrowserDiscoveryStrategyMetrics(runId) : undefined,
      metadata: JSON.parse(run.metadata_json || '{}'),
    };
  }

  recordProviderResult(runId, { provider, target = '', status, observations = 0, errorCode = null, errorMessage = null, startedAt = null, finishedAt = null } = {}) {
    const normalizedStatus = String(status || '').toUpperCase();
    if (!['SUCCESS', 'FAILED'].includes(normalizedStatus)) throw new TypeError('provider status must be SUCCESS or FAILED');
    this.db.prepare(`
      INSERT INTO run_provider_results(
        run_id, provider, target, status, observations_count, error_code, error_message, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, target) DO UPDATE SET
        status = excluded.status, observations_count = excluded.observations_count,
        error_code = excluded.error_code, error_message = excluded.error_message,
        started_at = excluded.started_at, finished_at = excluded.finished_at
    `).run(runId, requiredText(provider, 'provider'), String(target || ''), normalizedStatus,
      Number.isFinite(observations) ? observations : 0, errorCode, errorMessage,
      startedAt ? iso(startedAt, 'provider startedAt') : null,
      finishedAt ? iso(finishedAt, 'provider finishedAt') : null);
  }

  recordProviderResults(runId, results) {
    if (!Array.isArray(results)) throw new TypeError('provider results must be an array');
    this.db.transaction(items => { for (const item of items) this.recordProviderResult(runId, item); })(results);
  }

  getProviderResults(runId) {
    return this.db.prepare(`
      SELECT provider, target, status, observations_count AS observations,
        error_code AS errorCode, error_message AS errorMessage,
        started_at AS startedAt, finished_at AS finishedAt
      FROM run_provider_results WHERE run_id = ? ORDER BY provider, target
    `).all(runId);
  }

  getRunFailures(runId) {
    return this.db.prepare(`
      SELECT provider, target, code, message, retryable, recorded_at AS recordedAt
      FROM run_failures WHERE run_id = ? ORDER BY id
    `).all(runId).map(row => ({ ...row, retryable: Boolean(row.retryable) }));
  }

  recordRunFailure(runId, { provider = '', target = '', code = 'UPSTREAM_UNAVAILABLE', message, retryable = false } = {}) {
    this.db.prepare(`
      INSERT INTO run_failures(run_id, provider, target, code, message, retryable, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runId, provider || null, target || null, requiredText(code, 'failure code'), requiredText(message, 'failure message'), retryable ? 1 : 0, this.now());
  }

  findByExternalId(provider, externalId) {
    const row = this.db.prepare(`
      SELECT j.* FROM job_identities i JOIN jobs j ON j.id = i.job_id
      WHERE i.kind = 'external_id' AND i.namespace = ? AND i.value = ?
    `).get(normalizeProviderId(provider), String(externalId ?? '').trim());
    return row || null;
  }

  findByCanonicalUrl(url) {
    const normalized = canonicalizeJobUrl(url);
    if (!normalized) return null;
    const rows = this.db.prepare(`
      SELECT DISTINCT j.* FROM job_identities i JOIN jobs j ON j.id = i.job_id
      WHERE i.kind IN ('canonical_url', 'source_url') AND i.value = ?
    `).all(normalized);
    return rows.length === 1 ? rows[0] : null;
  }

  getJob(jobId) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) || null;
  }

  getObservations(jobId) {
    return this.db.prepare('SELECT * FROM job_observations WHERE job_id = ? ORDER BY first_observed_at, id').all(jobId);
  }

  recordAssessment(jobId, observationId, assessment) {
    const job = this.getJob(requiredText(jobId, 'jobId'));
    if (!job) throw new Error(`unknown job: ${jobId}`);
    const observation = this.db.prepare('SELECT * FROM job_observations WHERE id = ?').get(requiredText(observationId, 'observationId'));
    if (!observation || observation.job_id !== job.id) throw new Error(`observation ${observationId} does not belong to job ${jobId}`);
    const eligibility = assessment?.eligibility || {};
    const candidateFit = assessment?.candidateFit || {};
    const opportunity = assessment?.opportunity || {};
    const finalPriority = assessment?.finalPriority || {};
    const eligibilityRulesVersion = requiredText(assessment?.eligibilityRulesVersion, 'eligibilityRulesVersion');
    const rankingRulesVersion = requiredText(assessment?.rankingRulesVersion, 'rankingRulesVersion');
    const profileHash = requiredText(assessment?.profileHash, 'profileHash');
    const inputHash = requiredText(assessment?.inputHash, 'inputHash');
    const assessedAt = iso(assessment?.calculatedAt || this.now(), 'calculatedAt');
    const score = (value, name) => {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0 || number > 100) throw new TypeError(`${name} must be an integer from 0 to 100`);
      return number;
    };
    if (!['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN'].includes(eligibility.status)) throw new TypeError('invalid eligibility status');
    if (!['SHORTLIST', 'CONSIDER', 'REVIEW', 'REJECT'].includes(finalPriority.decision)) throw new TypeError('invalid priority decision');
    if (!VALID_CONFIDENCE.has(eligibility.confidence)) throw new TypeError('invalid eligibility confidence');
    const assessmentKey = hashStable(JSON.stringify({
      jobId: job.id, observationId: observation.id, eligibilityRulesVersion, rankingRulesVersion, profileHash, inputHash,
    }));
    const existing = this.db.prepare('SELECT * FROM job_assessments WHERE assessment_key = ?').get(assessmentKey);
    if (existing) return { ...this._assessmentRow(existing), existing: true };
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO job_assessments(
        id, assessment_key, job_id, observation_id, eligibility_status, eligibility_score,
        candidate_fit_score, opportunity_score, final_priority_score, decision, confidence,
        eligibility_rules_version, ranking_rules_version, profile_hash, input_hash,
        reasons_json, evidence_json, rules_applied_json, result_json, assessed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, assessmentKey, job.id, observation.id, eligibility.status,
      score(eligibility.eligibilityScore, 'eligibilityScore'),
      score(candidateFit.score, 'candidateFit score'),
      score(opportunity.score, 'opportunity score'),
      score(finalPriority.score, 'finalPriority score'),
      finalPriority.decision, eligibility.confidence,
      eligibilityRulesVersion, rankingRulesVersion, profileHash, inputHash,
      json(eligibility.reasons, []), json(eligibility.evidence, []), json(eligibility.rulesApplied, []),
      json(assessment), assessedAt, this.now(),
    );
    return this._assessmentRow(this.db.prepare('SELECT * FROM job_assessments WHERE id = ?').get(id));
  }

  _assessmentRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      jobId: row.job_id,
      observationId: row.observation_id,
      eligibilityStatus: row.eligibility_status,
      eligibilityScore: row.eligibility_score,
      candidateFitScore: row.candidate_fit_score,
      opportunityScore: row.opportunity_score,
      finalPriorityScore: row.final_priority_score,
      decision: row.decision,
      confidence: row.confidence,
      eligibilityRulesVersion: row.eligibility_rules_version,
      rankingRulesVersion: row.ranking_rules_version,
      profileHash: row.profile_hash,
      inputHash: row.input_hash,
      reasons: JSON.parse(row.reasons_json),
      evidence: JSON.parse(row.evidence_json),
      rulesApplied: JSON.parse(row.rules_applied_json),
      result: JSON.parse(row.result_json),
      assessedAt: row.assessed_at,
      createdAt: row.created_at,
    };
  }

  getAssessments(jobId) {
    return this.db.prepare('SELECT * FROM job_assessments WHERE job_id = ? ORDER BY assessed_at, rowid')
      .all(requiredText(jobId, 'jobId')).map(row => this._assessmentRow(row));
  }

  getLatestAssessment(jobId) {
    const row = this.db.prepare('SELECT * FROM job_assessments WHERE job_id = ? ORDER BY assessed_at DESC, rowid DESC LIMIT 1')
      .get(requiredText(jobId, 'jobId'));
    return this._assessmentRow(row);
  }

  recordJobEvaluation(artifact) {
    const jobId = requiredText(artifact?.jobId, 'jobId');
    const observationId = requiredText(artifact?.observationId, 'observationId');
    const assessmentId = requiredText(artifact?.assessmentId, 'assessmentId');
    const evaluationKey = requiredText(artifact?.evaluationKey, 'evaluationKey');
    const job = this.getJob(jobId);
    const observation = this.db.prepare('SELECT * FROM job_observations WHERE id = ?').get(observationId);
    const assessment = this.db.prepare('SELECT * FROM job_assessments WHERE id = ?').get(assessmentId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (!observation || observation.job_id !== jobId) throw new Error(`observation ${observationId} does not belong to job ${jobId}`);
    if (!assessment || assessment.job_id !== jobId || assessment.observation_id !== observationId) {
      throw new Error(`assessment ${assessmentId} does not belong to job ${jobId} and observation ${observationId}`);
    }
    if (assessment.decision !== 'SHORTLIST') throw new Error('job evaluation requires a SHORTLIST assessment');
    if (!['VALID', 'REJECTED'].includes(artifact.status)) throw new TypeError('evaluation status must be VALID or REJECTED');
    const existing = this.db.prepare('SELECT * FROM job_evaluations WHERE evaluation_key = ?').get(evaluationKey);
    if (existing) return { ...this._jobEvaluationRow(existing), existing: true };
    const provenance = artifact.provenance || {};
    const evaluation = artifact.evaluation || null;
    const id = randomUUID();
    const evaluatedAt=iso(artifact.evaluatedAt || this.now(), 'evaluatedAt');
    this.db.transaction(()=>{this.db.prepare(`
      INSERT INTO job_evaluations(
        id, evaluation_key, job_id, observation_id, assessment_id, status,
        recommendation, confidence, overall_fit, candidate_kb_version, candidate_kb_hash,
        candidate_kb_revision, evaluation_engine_version, prompt_version, provider_id, model_id,
        job_analysis_hash, job_analysis_json, evidence_matches_json, structured_output_json,
        rejected_output_json, validation_json, usage_json, evaluated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, evaluationKey, jobId, observationId, assessmentId, artifact.status,
      evaluation?.recommendation || null, evaluation?.confidence || null, evaluation?.overall_fit ?? null,
      Number(provenance.candidateKbVersion), requiredText(provenance.candidateKbHash, 'candidateKbHash'),
      requiredText(provenance.candidateKbRevision, 'candidateKbRevision'),
      requiredText(provenance.engineVersion, 'engineVersion'), requiredText(provenance.promptVersion, 'promptVersion'),
      requiredText(provenance.providerId, 'providerId'), requiredText(provenance.model, 'model'),
      requiredText(provenance.jobAnalysisHash, 'jobAnalysisHash'), json(artifact.jobAnalysis), json(artifact.evidenceMatches, []),
      evaluation ? json(evaluation) : null, artifact.rejectedOutput ? json(artifact.rejectedOutput) : null,
      json(artifact.validation), provenance.usage ? json(provenance.usage) : null,
      evaluatedAt, this.now(),
    );
    if(artifact.status==='VALID')this.recordWorkflowEvent({eventType:'EVALUATION_COMPLETED',aggregateType:'JOB',aggregateId:jobId,correlationId:this._eventCorrelationForJob(jobId,`evaluation:${id}`),causationId:assessmentId,occurredAt:evaluatedAt,source:'application_enrichment',actorType:'SYSTEM',payload:{recommendation:evaluation?.recommendation||null,confidence:evaluation?.confidence||null,evaluationId:id},metadata:{refs:{jobId,evaluationId:id}},dedupeKey:`evaluation:${id}:completed`});})();
    return this._jobEvaluationRow(this.db.prepare('SELECT * FROM job_evaluations WHERE id = ?').get(id));
  }

  _jobEvaluationRow(row) {
    if (!row) return null;
    const parse = value => value == null ? null : JSON.parse(value);
    return {
      id: row.id, evaluationKey: row.evaluation_key, jobId: row.job_id,
      observationId: row.observation_id, assessmentId: row.assessment_id, status: row.status,
      recommendation: row.recommendation, confidence: row.confidence, overallFit: row.overall_fit,
      jobAnalysis: parse(row.job_analysis_json), evidenceMatches: parse(row.evidence_matches_json),
      evaluation: parse(row.structured_output_json), rejectedOutput: parse(row.rejected_output_json),
      validation: parse(row.validation_json),
      provenance: {
        candidateKbVersion: row.candidate_kb_version, candidateKbHash: row.candidate_kb_hash,
        candidateKbRevision: row.candidate_kb_revision, engineVersion: row.evaluation_engine_version,
        promptVersion: row.prompt_version, providerId: row.provider_id, model: row.model_id,
        jobAnalysisHash: row.job_analysis_hash, usage: parse(row.usage_json),
      },
      evaluatedAt: row.evaluated_at, createdAt: row.created_at,
    };
  }

  getJobEvaluations(jobId) {
    return this.db.prepare('SELECT * FROM job_evaluations WHERE job_id = ? ORDER BY evaluated_at, rowid')
      .all(requiredText(jobId, 'jobId')).map(row => this._jobEvaluationRow(row));
  }

  getLatestJobEvaluation(jobId) {
    return this._jobEvaluationRow(this.db.prepare(
      'SELECT * FROM job_evaluations WHERE job_id = ? ORDER BY evaluated_at DESC, rowid DESC LIMIT 1',
    ).get(requiredText(jobId, 'jobId')));
  }

  getJobEvaluation(evaluationId) {
    return this._jobEvaluationRow(this.db.prepare('SELECT * FROM job_evaluations WHERE id = ?')
      .get(requiredText(evaluationId, 'evaluationId')));
  }

  recordApplicationPackage(artifact) {
    const jobId = requiredText(artifact?.jobId, 'jobId');
    const evaluationId = requiredText(artifact?.evaluationId, 'evaluationId');
    const packageKey = requiredText(artifact?.packageKey, 'packageKey');
    const evaluation = this.db.prepare('SELECT * FROM job_evaluations WHERE id = ?').get(evaluationId);
    if (!evaluation || evaluation.job_id !== jobId) throw new Error(`evaluation ${evaluationId} does not belong to job ${jobId}`);
    if (evaluation.status !== 'VALID' || evaluation.recommendation !== 'APPLY') throw new Error('application package requires a VALID APPLY evaluation');
    if (!['DRAFT', 'REVIEW_REQUIRED'].includes(artifact.status)) throw new TypeError('new application package status must be DRAFT or REVIEW_REQUIRED');
    if (!['VALID', 'REJECTED'].includes(artifact.validationStatus)) throw new TypeError('package validationStatus must be VALID or REJECTED');
    if ((artifact.validationStatus === 'VALID') !== (artifact.status === 'DRAFT')) throw new Error('VALID packages start as DRAFT; rejected packages start as REVIEW_REQUIRED');
    const existing = this.db.prepare('SELECT * FROM application_packages WHERE package_key = ?').get(packageKey);
    if (existing) return { ...this._applicationPackageRow(existing), existing: true };
    const provenance = artifact.provenance || {};
    const version = this.db.prepare('SELECT COALESCE(MAX(package_version), 0) + 1 AS version FROM application_packages WHERE job_id = ?').get(jobId).version;
    const id = randomUUID();
    const at = iso(artifact.generatedAt || this.now(), 'generatedAt');
    this.db.transaction(()=>{this.db.prepare(`
      INSERT INTO application_packages(
        id, package_key, package_version, job_id, evaluation_id, status, validation_status,
        evaluation_key, evaluation_hash, candidate_kb_version, candidate_kb_hash, candidate_kb_revision,
        cv_hash, cv_source, package_engine_version, prompt_version, provider_id, model_id,
        artifacts_json, rejected_output_json, evidence_refs_json, validation_json, usage_json,
        generated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, packageKey, version, jobId, evaluationId, artifact.status, artifact.validationStatus,
      requiredText(provenance.evaluationKey, 'evaluationKey'), requiredText(provenance.evaluationHash, 'evaluationHash'),
      Number(provenance.candidateKbVersion), requiredText(provenance.candidateKbHash, 'candidateKbHash'),
      requiredText(provenance.candidateKbRevision, 'candidateKbRevision'), requiredText(provenance.cvHash, 'cvHash'),
      requiredText(provenance.cvSource, 'cvSource'), requiredText(provenance.engineVersion, 'engineVersion'),
      requiredText(provenance.promptVersion, 'promptVersion'), requiredText(provenance.providerId, 'providerId'),
      requiredText(provenance.model, 'model'), artifact.artifacts ? json(artifact.artifacts) : null,
      artifact.rejectedOutput ? json(artifact.rejectedOutput) : null, json(artifact.evidenceUsed, []),
      json(artifact.validation), provenance.usage ? json(provenance.usage) : null, at, this.now(), this.now(),
    );
    if(artifact.validationStatus==='VALID')this.recordWorkflowEvent({eventType:'PACKAGE_GENERATED',aggregateType:'APPLICATION',aggregateId:id,correlationId:this._eventCorrelationForJob(jobId,`package:${id}`),causationId:evaluationId,occurredAt:at,source:'application_enrichment',actorType:'SYSTEM',payload:{packageId:id,version,status:artifact.status},metadata:{refs:{jobId,applicationId:id,evaluationId}},dedupeKey:`package:${id}:generated`});})();
    return this._applicationPackageRow(this.db.prepare('SELECT * FROM application_packages WHERE id = ?').get(id));
  }

  _applicationPackageRow(row) {
    if (!row) return null;
    const parse = value => value == null ? null : JSON.parse(value);
    return {
      id: row.id, packageKey: row.package_key, packageVersion: row.package_version,
      jobId: row.job_id, evaluationId: row.evaluation_id, status: row.status,
      validationStatus: row.validation_status, artifacts: parse(row.artifacts_json),
      rejectedOutput: parse(row.rejected_output_json), evidenceUsed: parse(row.evidence_refs_json),
      validation: parse(row.validation_json),
      provenance: {
        evaluationKey: row.evaluation_key, evaluationHash: row.evaluation_hash,
        candidateKbVersion: row.candidate_kb_version, candidateKbHash: row.candidate_kb_hash,
        candidateKbRevision: row.candidate_kb_revision, cvHash: row.cv_hash, cvSource: row.cv_source,
        engineVersion: row.package_engine_version, promptVersion: row.prompt_version,
        providerId: row.provider_id, model: row.model_id, usage: parse(row.usage_json),
      },
      generatedAt: row.generated_at, reviewedAt: row.reviewed_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  getApplicationPackages(jobId) {
    return this.db.prepare('SELECT * FROM application_packages WHERE job_id = ? ORDER BY package_version, rowid')
      .all(requiredText(jobId, 'jobId')).map(row => this._applicationPackageRow(row));
  }

  getLatestApplicationPackage(jobId) {
    return this._applicationPackageRow(this.db.prepare(
      'SELECT * FROM application_packages WHERE job_id = ? ORDER BY package_version DESC LIMIT 1',
    ).get(requiredText(jobId, 'jobId')));
  }

  recordContactResearch(artifact) {
    const jobId = requiredText(artifact?.jobId, 'jobId');
    const researchKey = requiredText(artifact?.researchKey, 'researchKey');
    const company = artifact?.company || {};
    if (!this.getJob(jobId)) throw new Error(`unknown job: ${jobId}`);
    if (artifact.applicationPackageId) {
      const pkg = this.db.prepare('SELECT job_id FROM application_packages WHERE id = ?').get(artifact.applicationPackageId);
      if (!pkg || pkg.job_id !== jobId) throw new Error('application package does not belong to contact research job');
    }
    if (artifact.status !== 'CONTACT_INTELLIGENCE_READY' || artifact.reviewStatus !== 'HUMAN_REVIEW_REQUIRED') throw new TypeError('contact research requires the human-review boundary');
    const existing = this.db.prepare('SELECT * FROM contact_research WHERE research_key = ?').get(researchKey);
    if (existing) return { ...this._contactResearchRow(existing), existing: true };
    const run = this.db.transaction(() => {
      const at = iso(artifact.researchedAt || this.now(), 'researchedAt');
      const normalizedName = requiredText(company.normalizedName, 'company.normalizedName');
      let companyRow = company.domain
        ? this.db.prepare('SELECT * FROM companies WHERE domain = ?').get(company.domain)
        : null;
      companyRow ||= this.db.prepare('SELECT * FROM companies WHERE normalized_name = ?').get(normalizedName);
      if (!companyRow) {
        const companyId = randomUUID();
        this.db.prepare('INSERT INTO companies(id, normalized_name, canonical_name, domain, confidence, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(companyId, normalizedName, requiredText(company.name, 'company.name'), company.domain || null, company.confidence, at, at);
        companyRow = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
      } else {
        this.db.prepare(`UPDATE companies SET canonical_name = ?, domain = COALESCE(domain, ?), confidence = CASE WHEN confidence = 'HIGH' OR (confidence = 'MEDIUM' AND ? = 'LOW') THEN confidence ELSE ? END, updated_at = ? WHERE id = ?`)
          .run(requiredText(company.name, 'company.name'), company.domain || null, company.confidence, company.confidence, at, companyRow.id);
      }
      this.db.prepare('INSERT OR REPLACE INTO job_companies(job_id, company_id, confidence, evidence_json, linked_at) VALUES (?, ?, ?, ?, ?)')
        .run(jobId, companyRow.id, company.confidence, json(company.evidence, []), at);
      for (const evidence of company.evidence || []) {
        this.db.prepare('INSERT OR IGNORE INTO company_evidence(company_id, evidence_id, field, source_hash, source_json, evidence_json, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(companyRow.id, evidence.id, evidence.field, evidence.source.sourceHash, json(evidence.source), json(evidence), at);
      }
      const peopleByRef = new Map();
      for (const person of artifact.people || []) {
        let row = person.profileUrl ? this.db.prepare('SELECT * FROM people WHERE company_id = ? AND profile_url = ?').get(companyRow.id, person.profileUrl) : null;
        row ||= this.db.prepare('SELECT * FROM people WHERE company_id = ? AND normalized_name = ?').get(companyRow.id, requiredText(person.normalizedName, 'person.normalizedName'));
        if (!row) {
          const id = randomUUID();
          this.db.prepare('INSERT INTO people(id, company_id, normalized_name, canonical_name, role, profile_url, status, confidence, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, companyRow.id, person.normalizedName, person.name, person.role || null, person.profileUrl || null, person.status, person.confidence, at, at);
          row = this.db.prepare('SELECT * FROM people WHERE id = ?').get(id);
        } else {
          this.db.prepare(`UPDATE people SET role = COALESCE(?, role), profile_url = COALESCE(profile_url, ?), status = CASE WHEN ? = 'CONFIRMED' THEN 'CONFIRMED' ELSE status END, confidence = CASE WHEN confidence = 'HIGH' OR (confidence = 'MEDIUM' AND ? = 'LOW') THEN confidence ELSE ? END, updated_at = ? WHERE id = ?`)
            .run(person.role || null, person.profileUrl || null, person.status, person.confidence, person.confidence, at, row.id);
        }
        for (const evidence of person.evidence || []) {
          this.db.prepare('INSERT OR IGNORE INTO person_evidence(person_id, evidence_id, field, source_hash, source_json, evidence_json, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(row.id, evidence.id, evidence.field, evidence.source.sourceHash, json(evidence.source), json(evidence), at);
        }
        peopleByRef.set(person.ref, row.id);
      }
      const contactVersion = this.db.prepare('SELECT COALESCE(MAX(contact_research_version), 0) + 1 AS version FROM contact_research WHERE job_id = ?').get(jobId).version;
      const companyVersion = this.db.prepare('SELECT COALESCE(MAX(company_research_version), 0) + 1 AS version FROM contact_research WHERE company_id = ?').get(companyRow.id).version;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO contact_research(
        id, research_key, contact_research_version, company_research_version, artifact_version, job_id,
        application_package_id, company_id, status, review_status, source_hash, engine_version,
        provider_id, provider_version, company_json, people_json, relationships_json,
        outreach_strategy_json, artifact_json, researched_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, researchKey, contactVersion, companyVersion, Number(artifact.artifactVersion), jobId,
          artifact.applicationPackageId || null, companyRow.id, artifact.status, artifact.reviewStatus,
          requiredText(artifact.sourceHash, 'sourceHash'), requiredText(artifact.provenance?.engineVersion, 'engineVersion'),
          requiredText(artifact.provenance?.providerId, 'providerId'), requiredText(artifact.provenance?.providerVersion, 'providerVersion'),
          json(company), json(artifact.people, []), json(artifact.relationships, []), json(artifact.outreachStrategy), json(artifact), at, this.now());
      for (const person of artifact.people || []) {
        this.db.prepare('INSERT INTO contact_research_people(research_id, person_id, person_ref) VALUES (?, ?, ?)')
          .run(id, peopleByRef.get(person.ref), person.ref);
      }
      for (const relationship of artifact.relationships || []) {
        const personId = peopleByRef.get(relationship.personRef);
        if (!personId) throw new Error(`relationship references unknown person: ${relationship.personRef}`);
        const relationshipSourceHash = hashStable(json((relationship.evidence || []).map(item => item.source?.sourceHash || '').sort()));
        this.db.prepare('INSERT INTO contact_relationships(id, research_id, job_id, company_id, person_id, relationship_type, status, confidence, source_hash, evidence_json, rationale, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), id, jobId, companyRow.id, personId, relationship.type, relationship.status, relationship.confidence, relationshipSourceHash, json(relationship.evidence, []), requiredText(relationship.rationale, 'relationship.rationale'), at);
      }
      return this.db.prepare('SELECT * FROM contact_research WHERE id = ?').get(id);
    });
    return this._contactResearchRow(run());
  }

  _contactResearchRow(row) {
    if (!row) return null;
    const artifact = JSON.parse(row.artifact_json);
    return {
      id: row.id, researchKey: row.research_key, contactResearchVersion: row.contact_research_version,
      companyResearchVersion: row.company_research_version, artifactVersion: row.artifact_version,
      jobId: row.job_id, applicationPackageId: row.application_package_id, companyId: row.company_id,
      status: row.status, reviewStatus: row.review_status, sourceHash: row.source_hash,
      company: JSON.parse(row.company_json), people: JSON.parse(row.people_json),
      relationships: JSON.parse(row.relationships_json), outreachStrategy: JSON.parse(row.outreach_strategy_json),
      artifact, completionStatus:artifact.completionStatus||'NOT_RUN',resultStatus:artifact.resultStatus||'',primaryContact:artifact.primaryContact||null,contacts:artifact.contacts||[],searchReport:artifact.searchReport||null,
      provenance: { engineVersion: row.engine_version, providerId: row.provider_id, providerVersion: row.provider_version },
      researchedAt: row.researched_at, createdAt: row.created_at,
    };
  }

  getContactResearch(jobId) {
    return this.db.prepare('SELECT * FROM contact_research WHERE job_id = ? ORDER BY contact_research_version, rowid')
      .all(requiredText(jobId, 'jobId')).map(row => this._contactResearchRow(row));
  }

  getLatestContactResearch(jobId) {
    return this._contactResearchRow(this.db.prepare('SELECT * FROM contact_research WHERE job_id = ? ORDER BY contact_research_version DESC LIMIT 1').get(requiredText(jobId, 'jobId')));
  }

  listContactResearchCandidates({ jobId = null, limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 100));
    return this.db.prepare(`
      SELECT p.* FROM application_packages p
      WHERE p.validation_status = 'VALID' AND p.status IN ('DRAFT', 'APPROVED')
        AND p.id = (SELECT newest.id FROM application_packages newest WHERE newest.job_id = p.job_id AND newest.validation_status = 'VALID' ORDER BY newest.package_version DESC LIMIT 1)
        AND (? IS NULL OR p.job_id = ?)
      ORDER BY p.generated_at, p.id LIMIT ?
    `).all(jobId, jobId, boundedLimit).map(row => this._applicationPackageRow(row));
  }

  getCompany(companyId) {
    const row = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(requiredText(companyId, 'companyId'));
    if (!row) return null;
    return { id: row.id, normalizedName: row.normalized_name, name: row.canonical_name, domain: row.domain, confidence: row.confidence, firstSeenAt: row.first_seen_at, updatedAt: row.updated_at };
  }

  getCompanyPeople(companyId) {
    return this.db.prepare('SELECT * FROM people WHERE company_id = ? ORDER BY normalized_name').all(requiredText(companyId, 'companyId')).map(row => ({
      id: row.id, companyId: row.company_id, normalizedName: row.normalized_name, name: row.canonical_name,
      role: row.role, profileUrl: row.profile_url, status: row.status, confidence: row.confidence,
      evidence: this.db.prepare('SELECT evidence_json FROM person_evidence WHERE person_id = ? ORDER BY observed_at, evidence_id').all(row.id).map(item => JSON.parse(item.evidence_json)),
      firstSeenAt: row.first_seen_at, updatedAt: row.updated_at,
    }));
  }

  recordSheetSync({ id = randomUUID(), spreadsheetId, direction, projectionHash, syncedAt = this.now(), result = {} } = {}) {
    const sheet = requiredText(spreadsheetId, 'spreadsheetId');
    const normalizedDirection = requiredText(direction, 'direction').toUpperCase();
    if (!['PUSH', 'PULL'].includes(normalizedDirection)) throw new TypeError('direction must be PUSH or PULL');
    const at = iso(syncedAt, 'syncedAt');
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO sheet_sync_runs(id, spreadsheet_id, direction, projection_hash, result_json, synced_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, sheet, normalizedDirection, requiredText(projectionHash, 'projectionHash'), json(result), at, this.now());
      this.db.prepare(`INSERT INTO sheet_sync_state(spreadsheet_id, projection_hash, last_push_at, last_pull_at, last_result_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(spreadsheet_id) DO UPDATE SET projection_hash = excluded.projection_hash,
          last_push_at = COALESCE(excluded.last_push_at, sheet_sync_state.last_push_at),
          last_pull_at = COALESCE(excluded.last_pull_at, sheet_sync_state.last_pull_at),
          last_result_json = excluded.last_result_json, updated_at = excluded.updated_at`)
        .run(sheet, projectionHash, normalizedDirection === 'PUSH' ? at : null, normalizedDirection === 'PULL' ? at : null, json(result), this.now());
      this.recordWorkflowEvent({ eventType:'SHEET_SYNC_COMPLETED', aggregateType:'SHEET_SYNC', aggregateId:id, correlationId:workflowEventContext.getStore()?.correlationId || `sheet-sync:${id}`, causationId:id, occurredAt:at, source:'sheet', actorType:'SYSTEM', payload:{ direction:normalizedDirection, projectionNames:result.tabs || [], counts:{ imported:result.imported || 0, rejected:result.rejected || 0 }, result:'SUCCESS' }, metadata:{ refs:{ spreadsheetId:sheet, syncRunId:id } }, dedupeKey:`sheet-sync:${id}:completed` });
    })();
    return { id, spreadsheetId: sheet, direction: normalizedDirection, projectionHash, result, syncedAt: at };
  }

  getSheetSyncState(spreadsheetId) {
    const row = this.db.prepare('SELECT * FROM sheet_sync_state WHERE spreadsheet_id = ?').get(requiredText(spreadsheetId, 'spreadsheetId'));
    return row ? { spreadsheetId: row.spreadsheet_id, projectionHash: row.projection_hash, lastPushAt: row.last_push_at, lastPullAt: row.last_pull_at, result: JSON.parse(row.last_result_json), updatedAt: row.updated_at } : null;
  }

  recordHumanActions({ accepted = [], rejected = [] } = {}) {
    const applied = []; const denied = [];
    this.db.transaction(() => {
      const affectedJobs = new Set(); const affectedCommunities = new Set();
      const writeState=(entityType,entityId,field,value,actionId,at)=>{
        if(entityType==='COMMUNITY')this.db.prepare(`INSERT INTO facebook_community_human_state(community_id,field_name,value_json,source_action_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(community_id,field_name) DO UPDATE SET value_json=excluded.value_json,source_action_id=excluded.source_action_id,updated_at=excluded.updated_at`).run(entityId,field,json(value,''),actionId,at);
        else this.db.prepare(`INSERT INTO human_field_state(entity_type,entity_id,field_name,value_json,source_action_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id,field_name) DO UPDATE SET value_json=excluded.value_json,source_action_id=excluded.source_action_id,updated_at=excluded.updated_at`).run(entityType,entityId,field,json(value,''),actionId,at);
      };
      for (const action of accepted) {
        const entityType = requiredText(action.entityType, 'entityType');
        const entityId = requiredText(action.entityId, 'entityId');
        if (entityType === 'JOB' && !this.getJob(entityId)) throw new Error(`unknown job human action: ${entityId}`);
        if (entityType === 'PERSON' && !this.db.prepare('SELECT id FROM people WHERE id = ?').get(entityId)) throw new Error(`unknown person human action: ${entityId}`);
        if (entityType === 'COMMUNITY' && !this.db.prepare('SELECT id FROM facebook_communities WHERE id = ?').get(entityId)) throw new Error(`unknown community human action: ${entityId}`);
        const existing = this.db.prepare('SELECT id FROM human_actions WHERE action_key = ?').get(action.actionKey);
        if (existing) {
          const importedAt = this.now();
          writeState(entityType,entityId,action.field,action.value,existing.id,importedAt);
          applied.push({ ...action, id: existing.id, existing: true });
          if (entityType === 'JOB') affectedJobs.add(entityId);
          if (entityType === 'COMMUNITY') affectedCommunities.add(entityId);
          continue;
        }
        const id = randomUUID(); const importedAt = this.now();
        this.db.prepare(`INSERT INTO human_actions(id, action_key, spreadsheet_id, tab_name, entity_type, entity_id, field_name, value_json, status, reason, observed_at, imported_at, actor, source_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'APPLIED', NULL, ?, ?, ?, ?)`)
          .run(id, requiredText(action.actionKey, 'actionKey'), requiredText(action.spreadsheetId, 'spreadsheetId'), requiredText(action.tabName, 'tabName'), entityType==='COMMUNITY'?'UNKNOWN':entityType, entityId, requiredText(action.field, 'field'), json(action.value, ''), iso(action.observedAt, 'observedAt'), importedAt, requiredText(action.user, 'user'), requiredText(action.sourceHash, 'sourceHash'));
        writeState(entityType,entityId,action.field,action.value,id,importedAt);
        applied.push({ ...action, id });
        if(entityType==='JOB'&&action.field==='application_status'&&String(action.value||'').toUpperCase()!=='NO_OUTCOME'){
          const outcome=String(action.value).toUpperCase(),eventType=({INTERVIEW:'APPLICATION_INTERVIEW',REJECTED:'APPLICATION_REJECTED',REJECTED_BY_COMPANY:'APPLICATION_REJECTED',OFFER:'APPLICATION_OFFER',HIRED:'APPLICATION_HIRED',WITHDRAWN:'APPLICATION_WITHDRAWN'})[outcome]||'APPLICATION_STATUS_CORRECTED';
          this.recordWorkflowEvent({eventType,aggregateType:'APPLICATION',aggregateId:entityId,correlationId:this._eventCorrelationForJob(entityId,`human-action:${id}`),causationId:id,occurredAt:importedAt,source:'sheet',actorType:'HUMAN',actorId:action.user||'sheet-user',payload:{outcome},metadata:{refs:{jobId:entityId,humanActionId:id}},dedupeKey:`human-action:${id}:${eventType}`});
        }
        if(entityType==='JOB'&&['follow_up_date','follow_up_action','next_action','interview_date'].includes(action.field))this.recordWorkflowEvent({eventType:'APPLICATION_FOLLOW_UP_UPDATED',aggregateType:'APPLICATION',aggregateId:entityId,correlationId:this._eventCorrelationForJob(entityId,`human-action:${id}`),causationId:id,occurredAt:importedAt,source:'sheet',actorType:'HUMAN',actorId:action.user||'sheet-user',payload:{field:action.field,value:action.value},metadata:{refs:{jobId:entityId,humanActionId:id}},dedupeKey:`human-action:${id}:follow-up-updated`});
        if (entityType === 'JOB') affectedJobs.add(entityId);
        if (entityType === 'COMMUNITY') affectedCommunities.add(entityId);
      }
      for (const rejection of rejected) {
        const identity = json(rejection);
        const actionKey = hashStable(`rejected:${identity}`);
        const existing = this.db.prepare('SELECT id FROM human_actions WHERE action_key = ?').get(actionKey);
        if (existing) { denied.push({ ...rejection, id: existing.id, existing: true }); continue; }
        const id = randomUUID();
        this.db.prepare(`INSERT INTO human_actions(id, action_key, spreadsheet_id, tab_name, entity_type, entity_id, field_name, value_json, status, reason, observed_at, imported_at, actor, source_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REJECTED', ?, ?, ?, ?, ?)`)
          .run(id, actionKey, rejection.spreadsheetId || 'unknown', rejection.tabName || 'UNKNOWN', 'UNKNOWN', rejection.entityId || 'unknown', rejection.field || 'unknown', json(rejection.value ?? ''), requiredText(rejection.reason, 'rejection reason'), iso(rejection.observedAt || this.now(), 'rejection observedAt'), this.now(), rejection.user || 'sheet-user', hashStable(identity));
        denied.push({ ...rejection, id });
      }
      for (const jobId of affectedJobs) this._reconcileHumanDecisionLifecycle(jobId);
      for (const communityId of affectedCommunities) this._reconcileFacebookCommunityLifecycle(communityId);
    })();
    return { applied, rejected: denied };
  }

  _humanFieldRow(jobId, field) {
    return this.db.prepare(`SELECT s.value_json, s.source_action_id, s.updated_at,
      a.actor, a.tab_name FROM human_field_state s
      JOIN human_actions a ON a.id = s.source_action_id
      WHERE s.entity_type = 'JOB' AND s.entity_id = ? AND s.field_name = ?`).get(jobId, field);
  }

  _reconcileFacebookCommunityLifecycle(communityId) {
    const decisionRow = this.db.prepare(`SELECT value_json,source_action_id,updated_at FROM facebook_community_human_state WHERE community_id=? AND field_name='membership_decision'`).get(communityId);
    if (!decisionRow) return;
    const decision = String(JSON.parse(decisionRow.value_json) || 'NO_ACTION').toUpperCase();
    const notes = JSON.parse(this.db.prepare(`SELECT value_json FROM facebook_community_human_state WHERE community_id=? AND field_name='notes'`).get(communityId)?.value_json || '""');
    const next = ({ WANT_TO_JOIN:'JOIN_REQUIRED', JOINED:'JOINED_CONFIRMED', SKIP:'SKIPPED', REJECT:'REJECTED' })[decision];
    if(decision!=='NO_ACTION')this.recordWorkflowEvent({eventType:'COMMUNITY_DECISION_IMPORTED',aggregateType:'COMMUNITY',aggregateId:communityId,correlationId:this._eventCorrelationForRef(decisionRow.source_action_id,`human-action:${decisionRow.source_action_id}`),causationId:decisionRow.source_action_id,source:'sheet',actorType:'HUMAN',actorId:'sheet-user',payload:{decision},metadata:{refs:{communityId,humanActionId:decisionRow.source_action_id}},dedupeKey:`human-action:${decisionRow.source_action_id}:community-decision`});
    if (['SKIP','REJECT'].includes(decision)) this.db.prepare(`UPDATE facebook_communities SET suppressed_at=COALESCE(suppressed_at,?),suppression_reason=?,suppression_action_id=?,join_status='NONE',updated_at=? WHERE id=?`).run(decisionRow.updated_at,`human_${decision.toLowerCase()}`,decisionRow.source_action_id,this.now(),communityId);
    if (next) this.transitionFacebookCommunity(communityId, next, { reason:`human_${decision.toLowerCase()}`, actionId:decisionRow.source_action_id });
    if (decision !== 'NO_ACTION') this.db.prepare(`INSERT INTO facebook_community_feedback(id,community_id,decision,notes,action_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET notes=excluded.notes`).run(randomUUID(),communityId,decision,String(notes||''),decisionRow.source_action_id,decisionRow.updated_at);
  }

  _reconcileHumanDecisionLifecycle(jobId) {
    const decisionState = this._humanFieldRow(jobId, 'human_decision');
    if (!decisionState) return;
    const decision = canonicalHumanDecision(JSON.parse(decisionState.value_json));
    const notes = JSON.parse(this._humanFieldRow(jobId, 'notes')?.value_json || '""');
    const reasonValue = JSON.parse(this._humanFieldRow(jobId, 'rejection_reason')?.value_json || '""');
    const reason = String(reasonValue || '').trim() || null;
    const now = this.now();
    const active = this.db.prepare('SELECT * FROM active_candidates WHERE job_id = ?').get(jobId);
    const decisionEventType=({REJECT:'JOB_REJECTED',HOLD:'JOB_HELD',NEXT_STAGE:'JOB_NEXT_STAGE_REQUESTED'})[decision];
    const decisionEvent=decisionEventType?this.recordWorkflowEvent({eventType:decisionEventType,aggregateType:'JOB',aggregateId:jobId,correlationId:this._eventCorrelationForRef(decisionState.source_action_id,`human-action:${decisionState.source_action_id}`),causationId:decisionState.source_action_id,source:'sheet',actorType:'HUMAN',actorId:decisionState.actor||'sheet-user',payload:{decision,reasonCode:reason||null},metadata:{refs:{jobId,humanActionId:decisionState.source_action_id}},dedupeKey:`human-action:${decisionState.source_action_id}:${decisionEventType}`}):null;

    if (decision === 'REJECT' && active) {
      this.db.prepare(`UPDATE active_candidates SET state = 'DISCARDED', state_reason = 'human_reject',
        last_reviewed_at = ?, updated_at = ? WHERE job_id = ?`).run(now, now, jobId);
    } else if (decision === 'HOLD' && active) {
      this.db.prepare(`UPDATE active_candidates SET state = 'CARRYOVER', state_reason = 'human_hold',
        last_reviewed_at = ?, updated_at = ? WHERE job_id = ?`).run(now, now, jobId);
    } else if (decision === 'NEXT_STAGE' && active && !['ACTIVE', 'CARRYOVER'].includes(active.state)) {
      this.db.prepare(`UPDATE active_candidates SET state = 'CARRYOVER', state_reason = 'human_next_stage',
        last_reviewed_at = ?, updated_at = ? WHERE job_id = ?`).run(now, now, jobId);
    }

    if (decision === 'REJECT') {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      const observation = this.db.prepare('SELECT * FROM job_observations WHERE job_id = ? ORDER BY last_observed_at DESC, rowid DESC LIMIT 1').get(jobId);
      const snapshot = this.db.prepare('SELECT * FROM daily_priority_snapshots WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(jobId);
      const candidateSnapshot = snapshot ? {
        runId: snapshot.run_id, rank: snapshot.rank, finalPriorityScore: snapshot.final_priority_score,
        eligibilityStatus: snapshot.eligibility_status, candidateFitScore: snapshot.candidate_fit_score,
        opportunityScore: snapshot.opportunity_score, decision: snapshot.decision,
      } : active ? { selectionRank: active.selection_rank, preliminaryScore: active.preliminary_score, state: active.state } : {};
      const feedbackId = `rejection-${hashStable(`${decisionState.source_action_id}:${jobId}`)}`;
      this.db.prepare(`INSERT INTO rejection_feedback(
        id, decision_action_id, job_id, observation_id, candidate_snapshot_json, company, role,
        source, human_decision, raw_notes, structured_reason, created_at, actor, action_source,
        policy_version, incorporated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REJECT', ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(decision_action_id) DO UPDATE SET raw_notes = excluded.raw_notes,
        structured_reason = excluded.structured_reason, updated_at = excluded.updated_at`)
        .run(feedbackId, decisionState.source_action_id, jobId, observation?.id || null,
          json(candidateSnapshot), job.canonical_company, job.canonical_title, observation?.provider || '',
          String(notes ?? ''), reason, decisionState.updated_at, decisionState.actor,
          `GOOGLE_SHEETS:${decisionState.tab_name}`, active?.policy_hash || HUMAN_DECISION_LIFECYCLE_VERSION, now);
    }

    if (decision === 'NEXT_STAGE') {
      const observation = this.db.prepare('SELECT id FROM job_observations WHERE job_id = ? ORDER BY last_observed_at DESC, rowid DESC LIMIT 1').get(jobId);
      const snapshot = this.db.prepare('SELECT rank FROM daily_priority_snapshots WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(jobId);
      const needs = this.db.prepare(`SELECT need_type type, dimension, status, priority, reason FROM candidate_research_needs
        WHERE job_id = ? AND status = 'OPEN' ORDER BY priority_score DESC, need_type`).all(jobId);
      const packageState = this.db.prepare('SELECT status FROM application_packages WHERE job_id = ? ORDER BY package_version DESC LIMIT 1').get(jobId)?.status || 'NOT_CREATED';
      const requestKey = hashStable(`${jobId}:${decisionState.source_action_id}:application-enrichment`);
      const enrichmentRequestId = `enrichment-${requestKey}`;
      const previousRequest = this.db.prepare('SELECT status FROM application_enrichment_requests WHERE id = ?').get(enrichmentRequestId);
      this.db.prepare(`INSERT INTO application_enrichment_requests(
        id, request_key, job_id, source_observation_id, requested_at, current_rank,
        research_state_json, package_state, human_notes, status, decision_action_id,
        cancelled_at, cancellation_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL, NULL, ?, ?)
      ON CONFLICT(request_key) DO UPDATE SET source_observation_id = excluded.source_observation_id,
        requested_at = excluded.requested_at, current_rank = excluded.current_rank,
        research_state_json = excluded.research_state_json, package_state = excluded.package_state,
        human_notes = excluded.human_notes,
        status = CASE WHEN application_enrichment_requests.status = 'CANCELLED' THEN 'PENDING' ELSE application_enrichment_requests.status END,
        cancelled_at = CASE WHEN application_enrichment_requests.status = 'CANCELLED' THEN NULL ELSE application_enrichment_requests.cancelled_at END,
        cancellation_reason = CASE WHEN application_enrichment_requests.status = 'CANCELLED' THEN NULL ELSE application_enrichment_requests.cancellation_reason END,
        updated_at = excluded.updated_at`)
        .run(enrichmentRequestId, requestKey, jobId, observation?.id || null,
          decisionState.updated_at, snapshot?.rank ?? null, json({ openNeeds: needs }), packageState,
          String(notes ?? ''), decisionState.source_action_id, now, now);
      const currentRequest = this.db.prepare('SELECT status FROM application_enrichment_requests WHERE id = ?').get(enrichmentRequestId);
      if (!this.db.prepare('SELECT 1 FROM application_enrichment_events WHERE request_id = ? LIMIT 1').get(enrichmentRequestId)) {
        this.db.prepare(`INSERT INTO application_enrichment_events(id,request_id,from_status,to_status,reason,run_id,lifecycle_version,evidence_refs_json,output_refs_json,occurred_at)
          VALUES (?, ?, NULL, ?, 'human_next_stage', ?, ?, '[]', '[]', ?)`).run(randomUUID(), enrichmentRequestId, currentRequest.status, decisionState.source_action_id, APPLICATION_ENRICHMENT_VERSION, now);
        this.recordWorkflowEvent({eventType:'ENRICHMENT_QUEUED',aggregateType:'ENRICHMENT',aggregateId:enrichmentRequestId,correlationId:this._eventCorrelationForRef(decisionState.source_action_id,`human-action:${decisionState.source_action_id}`),causationId:decisionEvent?.event?.event_id||decisionState.source_action_id,source:'application_enrichment',actorType:'SYSTEM',payload:{status:currentRequest.status},metadata:{refs:{jobId,humanActionId:decisionState.source_action_id,enrichmentRequestId}},dedupeKey:`enrichment:${enrichmentRequestId}:queued`});
      } else if (previousRequest?.status === 'CANCELLED' && currentRequest.status === 'PENDING') {
        this.db.prepare(`INSERT INTO application_enrichment_events(id,request_id,from_status,to_status,reason,run_id,lifecycle_version,evidence_refs_json,output_refs_json,occurred_at)
          VALUES (?, ?, 'CANCELLED', 'PENDING', 'human_next_stage_reactivated', ?, ?, '[]', '[]', ?)`).run(randomUUID(), enrichmentRequestId, decisionState.source_action_id, APPLICATION_ENRICHMENT_VERSION, now);
        this.recordWorkflowEvent({eventType:'ENRICHMENT_QUEUED',aggregateType:'ENRICHMENT',aggregateId:enrichmentRequestId,correlationId:this._eventCorrelationForRef(decisionState.source_action_id,`human-action:${decisionState.source_action_id}`),causationId:decisionEvent?.event?.event_id||decisionState.source_action_id,source:'application_enrichment',actorType:'SYSTEM',payload:{status:'PENDING',reactivated:true},metadata:{refs:{jobId,humanActionId:decisionState.source_action_id,enrichmentRequestId}},dedupeKey:`enrichment:${enrichmentRequestId}:reactivated:${decisionState.source_action_id}`});
      }
    } else {
      const cancelling = this.db.prepare(`SELECT id,status FROM application_enrichment_requests
        WHERE job_id = ? AND status IN ('PENDING', 'RESEARCHING', 'EVALUATING', 'GENERATING_PACKAGE')`).all(jobId);
      this.db.prepare(`UPDATE application_enrichment_requests SET status = 'CANCELLED',
        cancelled_at = ?, cancellation_reason = ?, updated_at = ?
        WHERE job_id = ? AND status IN ('PENDING', 'RESEARCHING', 'EVALUATING', 'GENERATING_PACKAGE')`)
        .run(now, `human_decision_${decision.toLowerCase()}`, now, jobId);
      for (const request of cancelling) this.db.prepare(`INSERT INTO application_enrichment_events(id,request_id,from_status,to_status,reason,run_id,lifecycle_version,evidence_refs_json,output_refs_json,occurred_at)
        VALUES (?, ?, ?, 'CANCELLED', ?, ?, ?, '[]', '[]', ?)`).run(randomUUID(), request.id, request.status,
          `human_decision_${decision.toLowerCase()}`, decisionState.source_action_id, APPLICATION_ENRICHMENT_VERSION, now);
    }

    if (decision === 'REJECT') this.rebuildPreferenceSignals({ incorporatedAt: now });
  }

  listRejectionFeedback({ jobId = null, limit = 1000 } = {}) {
    const bounded = Math.max(1, Math.min(10000, Number(limit) || 1000));
    return this.db.prepare(`SELECT * FROM rejection_feedback WHERE (? IS NULL OR job_id = ?)
      ORDER BY created_at DESC, id LIMIT ?`).all(jobId, jobId, bounded).map(row => ({
      id: row.id, decisionActionId: row.decision_action_id, jobId: row.job_id,
      observationId: row.observation_id, candidateSnapshot: JSON.parse(row.candidate_snapshot_json),
      company: row.company, role: row.role, source: row.source, humanDecision: row.human_decision,
      rawNotes: row.raw_notes, structuredReason: row.structured_reason, createdAt: row.created_at,
      actor: row.actor, actionSource: row.action_source, policyVersion: row.policy_version,
      incorporatedAt: row.incorporated_at, updatedAt: row.updated_at,
    }));
  }

  rebuildPreferenceSignals({ incorporatedAt = this.now() } = {}) {
    const feedback = this.listRejectionFeedback();
    const signals = derivePreferenceSignals(feedback);
    this.db.prepare('UPDATE preference_signals SET active = 0, updated_at = ?').run(incorporatedAt);
    const write = this.db.prepare(`INSERT INTO preference_signals(
      id, signal_key, level, category, scope_type, scope_value, reason, evidence_count,
      supporting_rejection_ids_json, confidence, score_adjustment, first_seen, last_seen,
      version, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(signal_key) DO UPDATE SET level = excluded.level, evidence_count = excluded.evidence_count,
      supporting_rejection_ids_json = excluded.supporting_rejection_ids_json,
      confidence = excluded.confidence, score_adjustment = excluded.score_adjustment,
      first_seen = excluded.first_seen, last_seen = excluded.last_seen, version = excluded.version,
      active = 1, updated_at = excluded.updated_at`);
    for (const signal of signals) write.run(signal.id, signal.signalKey, signal.level, signal.category,
      signal.scopeType, signal.scopeValue, signal.reason, signal.evidenceCount,
      json(signal.supportingRejectionIds, []), signal.confidence, signal.scoreAdjustment,
      signal.firstSeen, signal.lastSeen, signal.version, incorporatedAt, incorporatedAt);
    this.db.prepare('UPDATE rejection_feedback SET incorporated_at = ?, updated_at = ? WHERE incorporated_at IS NULL').run(incorporatedAt, incorporatedAt);
    return signals;
  }

  listPreferenceSignals({ activeOnly = true } = {}) {
    return this.db.prepare(`SELECT * FROM preference_signals ${activeOnly ? 'WHERE active = 1' : ''}
      ORDER BY evidence_count DESC, signal_key`).all().map(row => ({
      id: row.id, signalKey: row.signal_key, level: row.level, category: row.category,
      scopeType: row.scope_type, scopeValue: row.scope_value, reason: row.reason,
      evidenceCount: row.evidence_count, supportingRejectionIds: JSON.parse(row.supporting_rejection_ids_json),
      confidence: row.confidence, scoreAdjustment: row.score_adjustment,
      firstSeen: row.first_seen, lastSeen: row.last_seen, version: row.version, active: Boolean(row.active),
    }));
  }

  _enrichmentRequestRow(row) {
    if (!row) return null;
    const parse = (value, fallback) => { try { return JSON.parse(value ?? JSON.stringify(fallback)); } catch { return fallback; } };
    return {
      id: row.id, requestKey: row.request_key, jobId: row.job_id,
      sourceObservationId: row.source_observation_id, requestedAt: row.requested_at,
      currentRank: row.current_rank, researchState: parse(row.research_state_json, {}),
      packageState: row.package_state, humanNotes: row.human_notes, status: row.status,
      decisionActionId: row.decision_action_id, claimedByRunId: row.claimed_by_run_id,
      claimExpiresAt: row.claim_expires_at, attemptCount: row.attempt_count,
      currentStageStartedAt: row.current_stage_started_at, terminalReason: row.terminal_reason,
      lastErrorCode: row.last_error_code, researchPlan: parse(row.research_plan_json, {}),
      researchReport: parse(row.research_report_json, {}), evaluationId: row.evaluation_id,
      packageId: row.package_id, contactResearchId: row.contact_research_id,
      applicationPlan: parse(row.application_plan_json, {}), contactPlan: parse(row.contact_plan_json, {}),
      enrichmentCompletion: parse(row.enrichment_completion_json, {}),
      artifactManifest: parse(row.artifact_manifest_json, {}), inputHash: row.input_hash,
      outputRefs: parse(row.output_refs_json, []), cancelledAt: row.cancelled_at,
      cancellationReason: row.cancellation_reason, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  listEnrichmentRequests({ status = null, jobId = null } = {}) {
    return this.db.prepare(`SELECT * FROM application_enrichment_requests
      WHERE (? IS NULL OR status = ?) AND (? IS NULL OR job_id = ?)
      ORDER BY requested_at, id`).all(status, status, jobId, jobId).map(row => this._enrichmentRequestRow(row));
  }

  getEnrichmentRequest(requestId) {
    return this._enrichmentRequestRow(this.db.prepare('SELECT * FROM application_enrichment_requests WHERE id = ?').get(requiredText(requestId, 'requestId')));
  }

  getEnrichmentRequestEvents(requestId) {
    return this.db.prepare('SELECT * FROM application_enrichment_events WHERE request_id = ? ORDER BY occurred_at, rowid').all(requiredText(requestId, 'requestId')).map(row => ({
      id: row.id, requestId: row.request_id, fromStatus: row.from_status, toStatus: row.to_status,
      reason: row.reason, runId: row.run_id, lifecycleVersion: row.lifecycle_version,
      evidenceRefs: JSON.parse(row.evidence_refs_json), outputRefs: JSON.parse(row.output_refs_json), occurredAt: row.occurred_at,
    }));
  }

  recoverExpiredEnrichmentClaims({ at = this.now() } = {}) {
    const now = iso(at, 'at');
    const rows = this.db.prepare(`SELECT * FROM application_enrichment_requests
      WHERE status IN ('RESEARCHING','EVALUATING','GENERATING_PACKAGE') AND claim_expires_at IS NOT NULL AND claim_expires_at < ?`).all(now);
    const run = this.db.transaction(() => {
      for (const row of rows) {
        this.db.prepare(`UPDATE application_enrichment_requests SET status='PENDING', claimed_by_run_id=NULL,
          claim_expires_at=NULL, current_stage_started_at=NULL, last_error_code='LEASE_EXPIRED', updated_at=? WHERE id=?`).run(now, row.id);
        this.db.prepare(`INSERT INTO application_enrichment_events(id,request_id,from_status,to_status,reason,run_id,lifecycle_version,evidence_refs_json,output_refs_json,occurred_at)
          VALUES (?, ?, ?, 'PENDING', 'lease_expired_recovery', ?, ?, '[]', '[]', ?)`).run(randomUUID(), row.id, row.status, row.claimed_by_run_id, APPLICATION_ENRICHMENT_VERSION, now);
      }
    }); run(); return rows.length;
  }

  claimNextEnrichmentRequest({ runId, requestId = null, jobId = null, leaseSeconds = 1800, at = this.now() } = {}) {
    const worker = requiredText(runId, 'runId'); const now = iso(at, 'at');
    this.recoverExpiredEnrichmentClaims({ at: now });
    const expires = new Date(new Date(now).getTime() + Math.max(60, Number(leaseSeconds) || 1800) * 1000).toISOString();
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM application_enrichment_requests WHERE status='PENDING'
        AND (? IS NULL OR id=?) AND (? IS NULL OR job_id=?) ORDER BY requested_at,id LIMIT 1`).get(requestId, requestId, jobId, jobId);
      if (!row) return null;
      const changed = this.db.prepare(`UPDATE application_enrichment_requests SET status='RESEARCHING', claimed_by_run_id=?,
        claim_expires_at=?, attempt_count=attempt_count+1, current_stage_started_at=?, terminal_reason=NULL,
        last_error_code=NULL, updated_at=? WHERE id=? AND status='PENDING'`).run(worker, expires, now, now, row.id).changes;
      if (!changed) return null;
      this.db.prepare(`INSERT INTO application_enrichment_events(id,request_id,from_status,to_status,reason,run_id,lifecycle_version,evidence_refs_json,output_refs_json,occurred_at)
        VALUES (?, ?, 'PENDING', 'RESEARCHING', 'claimed', ?, ?, '[]', '[]', ?)`).run(randomUUID(), row.id, worker, APPLICATION_ENRICHMENT_VERSION, now);
      const queued=this.db.prepare("SELECT event_id,correlation_id FROM workflow_events WHERE dedupe_key=?").get(`enrichment:${row.id}:queued`);
      this.recordWorkflowEvent({eventType:'ENRICHMENT_STARTED',aggregateType:'ENRICHMENT',aggregateId:row.id,correlationId:queued?.correlation_id||this._eventCorrelationForRef(row.decision_action_id,`enrichment-run:${worker}`),causationId:queued?.event_id||worker,occurredAt:now,source:'application_enrichment',actorType:'SYSTEM',payload:{fromStatus:'PENDING',toStatus:'RESEARCHING'},metadata:{refs:{jobId:row.job_id,enrichmentRequestId:row.id,runId:worker}},dedupeKey:`enrichment:${row.id}:started`});
      return this.getEnrichmentRequest(row.id);
    }); return claim();
  }

  transitionEnrichmentRequest(requestId, toStatus, { reason, runId = null, evidenceRefs = [], outputRefs = [], errorCode = null, at = this.now() } = {}) {
    const id = requiredText(requestId, 'requestId'); const next = requiredText(toStatus, 'toStatus').toUpperCase(); const why = requiredText(reason, 'reason'); const now = iso(at, 'at');
    const run = this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM application_enrichment_requests WHERE id=?').get(id);
      if (!current) throw new Error(`unknown enrichment request: ${id}`);
      if (next === 'READY_FOR_REVIEW') {
        let completion = {}; try { completion = JSON.parse(current.enrichment_completion_json || '{}'); } catch {}
        if (!isEnrichmentCompletionRecord(completion)) throw new Error('READY_FOR_REVIEW requires a valid enrichment completion record');
        const evaluation=this.getLatestJobEvaluation(current.job_id),applicationPackage=current.package_id?this._applicationPackageRow(this.db.prepare('SELECT * FROM application_packages WHERE id=?').get(current.package_id)):null;
        let applicationPlan={};let artifactManifest={};try{applicationPlan=JSON.parse(current.application_plan_json||'{}');}catch{}try{artifactManifest=JSON.parse(current.artifact_manifest_json||'{}');}catch{}
        const readiness=validateApplicationReadiness({evaluation,applicationPlan,applicationPackage,latestApplicationPackage:this.getLatestApplicationPackage(current.job_id),artifactManifest,completion,packageState:current.package_state,blockers:current.last_error_code?[current.last_error_code]:[]});
        if(!readiness.ready){const error=new Error(`READY_FOR_REVIEW readiness invariant failed: ${readiness.failures.map(item=>item.code).join(', ')}`);error.code='APPLICATION_NOT_READY';error.readiness=readiness;throw error;}
      }
      if (current.status === next) return this._enrichmentRequestRow(current);
      if (!(ENRICHMENT_TRANSITIONS[current.status] || []).includes(next)) throw new Error(`enrichment request cannot transition from ${current.status} to ${next}`);
      const terminal = ['READY_FOR_REVIEW','BLOCKED','FAILED','CANCELLED'].includes(next);
      this.db.prepare(`UPDATE application_enrichment_requests SET status=?, current_stage_started_at=?,
        terminal_reason=?, last_error_code=?, output_refs_json=?, claimed_by_run_id=?, claim_expires_at=?, updated_at=? WHERE id=?`)
        .run(next, now, terminal ? why : null, errorCode, json(outputRefs, []), terminal ? null : current.claimed_by_run_id, terminal ? null : current.claim_expires_at, now, id);
      this.db.prepare(`INSERT INTO application_enrichment_events(id,request_id,from_status,to_status,reason,run_id,lifecycle_version,evidence_refs_json,output_refs_json,occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, current.status, next, why, runId, APPLICATION_ENRICHMENT_VERSION, json(evidenceRefs, []), json(outputRefs, []), now);
      const type=next==='READY_FOR_REVIEW'?'ENRICHMENT_COMPLETED':next==='BLOCKED'?'ENRICHMENT_BLOCKED':next==='FAILED'?'ENRICHMENT_FAILED':null;
      if(type){const prior=this.db.prepare("SELECT event_id,correlation_id FROM workflow_events WHERE aggregate_type='ENRICHMENT' AND aggregate_id=? ORDER BY occurred_at DESC,event_id DESC LIMIT 1").get(id);this.recordWorkflowEvent({eventType:type,aggregateType:'ENRICHMENT',aggregateId:id,correlationId:prior?.correlation_id||this._eventCorrelationForRef(current.decision_action_id,`enrichment-run:${runId||id}`),causationId:prior?.event_id||runId||id,occurredAt:now,source:'application_enrichment',actorType:'SYSTEM',payload:{fromStatus:current.status,toStatus:next,reasonCode:why,errorCode},metadata:{refs:{jobId:current.job_id,enrichmentRequestId:id,runId,evidenceRefs,outputRefs}},dedupeKey:`enrichment:${id}:${next.toLowerCase()}`});}
      return this.getEnrichmentRequest(id);
    }); return run();
  }

  updateEnrichmentRequestData(requestId, patch = {}) {
    const current = this.getEnrichmentRequest(requestId); if (!current) throw new Error(`unknown enrichment request: ${requestId}`);
    const value = (key, fallback) => Object.hasOwn(patch, key) ? patch[key] : fallback;
    this.db.prepare(`UPDATE application_enrichment_requests SET research_plan_json=?,research_report_json=?,evaluation_id=?,
      package_id=?,contact_research_id=?,package_state=?,application_plan_json=?,contact_plan_json=?,enrichment_completion_json=?,artifact_manifest_json=?,
      input_hash=?,output_refs_json=?,updated_at=? WHERE id=?`).run(
      json(value('researchPlan', current.researchPlan), {}), json(value('researchReport', current.researchReport), {}), value('evaluationId', current.evaluationId),
      value('packageId', current.packageId), value('contactResearchId', current.contactResearchId), value('packageState', current.packageState),
      json(value('applicationPlan', current.applicationPlan), {}), json(value('contactPlan', current.contactPlan), {}), json(value('enrichmentCompletion', current.enrichmentCompletion), {}), json(value('artifactManifest', current.artifactManifest), {}),
      value('inputHash', current.inputHash), json(value('outputRefs', current.outputRefs), []), this.now(), requestId);
    return this.getEnrichmentRequest(requestId);
  }

  createApplicationExecutionAuthorization({jobId,decisionActionId,executionPlan,authorizationSource='GOOGLE_SHEETS',supersedesAuthorizationId=null}={}){
    const job=requiredText(jobId,'jobId'),action=requiredText(decisionActionId,'decisionActionId');const plan=executionPlan||{};
    if(this.db.prepare("SELECT 1 FROM application_executions WHERE job_id=? AND status='APPLIED' LIMIT 1").get(job))throw new Error('logical application is already APPLIED');
    if(plan.status!=='READY'||plan.jobId!==job)throw new Error(`execution plan is not READY for exact job ${job}`);
    const request=this.getEnrichmentRequest(requiredText(plan.enrichmentRequestId,'enrichmentRequestId'));if(!request||request.jobId!==job||request.status!=='READY_FOR_REVIEW')throw new Error('enrichment request is not READY_FOR_REVIEW for exact job');
    const pkg=this.getLatestApplicationPackage(job);if(!pkg||pkg.id!==plan.packageId||pkg.validationStatus!=='VALID')throw new Error('approved package is not the latest VALID package for exact job');
    const readiness=validateApplicationReadiness({evaluation:this.getLatestJobEvaluation(job),applicationPlan:request.applicationPlan,applicationPackage:pkg,latestApplicationPackage:pkg,artifactManifest:request.artifactManifest,completion:request.enrichmentCompletion,packageState:request.packageState,blockers:request.lastErrorCode?[request.lastErrorCode]:[]});if(!readiness.ready)throw new Error(`application authorization blocked by readiness invariant: ${readiness.failures.map(item=>item.code).join(', ')}`);
    const actionRow=this.db.prepare('SELECT * FROM human_actions WHERE id=?').get(action);if(!actionRow||actionRow.entity_id!==job||actionRow.field_name!=='application_decision'||JSON.parse(actionRow.value_json)!=='APPROVE_TO_APPLY')throw new Error('exact APPROVE_TO_APPLY human action is required');
    const packageHash=hashStable(json({id:pkg.id,version:pkg.packageVersion,provenance:pkg.provenance,artifacts:plan.artifactHashes}));const authorizationKey=hashStable(`${job}:${plan.planHash}:${action}:${APPLICATION_ENRICHMENT_VERSION}`);const now=this.now();const existing=this.db.prepare('SELECT * FROM application_execution_authorizations WHERE authorization_key=?').get(authorizationKey);if(existing)return this._applicationAuthorizationRow(existing);
    const supersedes=supersedesAuthorizationId?this.getApplicationExecutionAuthorization(supersedesAuthorizationId):null;if(supersedesAuthorizationId&&(!supersedes||supersedes.jobId!==job))throw new Error('superseded authorization must belong to the exact job');if(supersedes&&!['CANCELLED'].includes(supersedes.status))throw new Error('superseded authorization must be cancelled first');
    const id=`application-authorization-${authorizationKey}`;this.db.transaction(()=>{this.db.prepare(`INSERT INTO application_execution_authorizations(id,authorization_key,decision_action_id,job_id,enrichment_request_id,package_id,package_hash,execution_plan_json,execution_plan_hash,authorization_source,status,approved_at,created_at,updated_at,supersedes_authorization_id,supersession_reason) VALUES(?,?,?,?,?,?,?,?,?,?, 'APPROVED_TO_APPLY',?,?,?,?,?)`).run(id,authorizationKey,action,job,request.id,pkg.id,packageHash,json(plan),requiredText(plan.planHash,'planHash'),requiredText(authorizationSource,'authorizationSource'),now,now,now,supersedesAuthorizationId,supersedesAuthorizationId?'STALE_PACKAGE':null);if(supersedesAuthorizationId)this.db.prepare('UPDATE application_execution_authorizations SET superseded_by_authorization_id=?,updated_at=? WHERE id=?').run(id,now,supersedesAuthorizationId);this.recordWorkflowEvent({eventType:'APPLICATION_APPROVED',aggregateType:'APPLICATION',aggregateId:id,correlationId:this._eventCorrelationForRef(action,this._eventCorrelationForJob(job,`human-action:${action}`)),causationId:action,occurredAt:now,source:'sheet',actorType:'HUMAN',actorId:actionRow.actor||'sheet-user',payload:{status:'APPROVED_TO_APPLY'},metadata:{refs:{jobId:job,applicationId:id,humanActionId:action,enrichmentRequestId:request.id,packageId:pkg.id}},dedupeKey:`application:${id}:approved`});})();return this.getApplicationExecutionAuthorization(id);
  }
  _applicationAuthorizationRow(r){return r?{id:r.id,authorizationKey:r.authorization_key,decisionActionId:r.decision_action_id,jobId:r.job_id,enrichmentRequestId:r.enrichment_request_id,packageId:r.package_id,packageHash:r.package_hash,executionPlan:JSON.parse(r.execution_plan_json),executionPlanHash:r.execution_plan_hash,authorizationSource:r.authorization_source,status:r.status,supersedesAuthorizationId:r.supersedes_authorization_id||null,supersededByAuthorizationId:r.superseded_by_authorization_id||null,supersessionReason:r.supersession_reason||null,supersededAt:r.superseded_at||null,approvedAt:r.approved_at,createdAt:r.created_at,updatedAt:r.updated_at}:null;}
  getApplicationExecutionAuthorization(id){return this._applicationAuthorizationRow(this.db.prepare('SELECT * FROM application_execution_authorizations WHERE id=?').get(requiredText(id,'authorizationId')));}
  listApplicationExecutionAuthorizations({status=null,jobId=null}={}){return this.db.prepare('SELECT * FROM application_execution_authorizations WHERE (? IS NULL OR status=?) AND (? IS NULL OR job_id=?) ORDER BY approved_at,id').all(status,status,jobId,jobId).map(r=>this._applicationAuthorizationRow(r));}
  createOutreachAuthorization({jobId,decisionActionId,outreachPlan,authorizationSource='GOOGLE_SHEETS'}={}){
    const job=requiredText(jobId,'jobId'),action=requiredText(decisionActionId,'decisionActionId'),plan=outreachPlan||{};
    const request=this.listEnrichmentRequests({jobId:job}).filter(item=>item.status==='READY_FOR_REVIEW').at(-1);
    if(!request||request.applicationPlan?.activation?.status!=='ACTIVATION_READY')throw new Error('exact ACTIVATION_READY plan is required');
    if(!['OUTREACH_RECOMMENDED','OUTREACH_OPTIONAL'].includes(request.applicationPlan.activation.outreachStrategy))throw new Error('outreach is not relevant for this job');
    if(plan.hash!==request.applicationPlan.activation.outreachPlan?.hash)throw new Error('outreach plan is stale or does not match the exact job plan');
    const actionRow=this.db.prepare('SELECT * FROM human_actions WHERE id=?').get(action);
    if(!actionRow||actionRow.entity_id!==job||actionRow.field_name!=='outreach_decision'||JSON.parse(actionRow.value_json)!=='APPROVE_OUTREACH')throw new Error('exact APPROVE_OUTREACH human action is required');
    const key=hashStable(`${job}:${plan.hash}:${action}:4.3`),existing=this.db.prepare('SELECT * FROM outreach_authorizations WHERE authorization_key=?').get(key);
    if(existing)return this._outreachAuthorizationRow(existing);
    const id=`outreach-authorization-${key}`,now=this.now();
    this.db.prepare(`INSERT INTO outreach_authorizations(id,authorization_key,decision_action_id,job_id,enrichment_request_id,outreach_plan_json,outreach_plan_hash,authorization_source,status,approved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'APPROVED_OUTREACH',?,?,?)`).run(id,key,action,job,request.id,json(plan),requiredText(plan.hash,'outreach plan hash'),requiredText(authorizationSource,'authorizationSource'),now,now,now);
    this.recordWorkflowEvent({eventType:'OUTREACH_AUTHORIZED',aggregateType:'OUTREACH',aggregateId:id,correlationId:this._eventCorrelationForJob(job,`outreach:${id}`),occurredAt:now,source:'outreach_execution',actorType:'HUMAN',payload:{channel:plan.channel,timing:plan.timing,messageVersion:plan.version},metadata:{refs:{jobId:job,outreachAuthorizationId:id}},dedupeKey:`outreach:${id}:authorized`});
    return this.getOutreachAuthorization(id);
  }
  _outreachAuthorizationRow(r){return r?{id:r.id,authorizationKey:r.authorization_key,decisionActionId:r.decision_action_id,jobId:r.job_id,enrichmentRequestId:r.enrichment_request_id,outreachPlan:JSON.parse(r.outreach_plan_json),outreachPlanHash:r.outreach_plan_hash,authorizationSource:r.authorization_source,status:r.status,approvedAt:r.approved_at,scheduledAt:r.scheduled_at||null,expiresAt:r.expires_at||null,createdAt:r.created_at,updatedAt:r.updated_at}:null;}
  getOutreachAuthorization(id){return this._outreachAuthorizationRow(this.db.prepare('SELECT * FROM outreach_authorizations WHERE id=?').get(requiredText(id,'outreachAuthorizationId')));}
  listOutreachAuthorizations({status=null,jobId=null}={}){return this.db.prepare('SELECT * FROM outreach_authorizations WHERE (? IS NULL OR status=?) AND (? IS NULL OR job_id=?) ORDER BY approved_at,id').all(status,status,jobId,jobId).map(row=>this._outreachAuthorizationRow(row));}
  scheduleOutreachAuthorization(id,scheduledAt){const authorization=this.getOutreachAuthorization(id);if(!authorization)throw new Error('unknown outreach authorization');if(authorization.status!=='APPROVED_OUTREACH')return authorization;const at=new Date(requiredText(scheduledAt,'scheduledAt')).toISOString(),now=this.now();this.db.prepare('UPDATE outreach_authorizations SET scheduled_at=?,updated_at=? WHERE id=?').run(at,now,id);this.recordWorkflowEvent({eventType:'OUTREACH_SCHEDULED',aggregateType:'OUTREACH',aggregateId:id,correlationId:this._eventCorrelationForJob(authorization.jobId,`outreach:${id}`),occurredAt:now,source:'outreach_execution',actorType:'SYSTEM',payload:{scheduledAt:at,timing:authorization.outreachPlan.timing},metadata:{refs:{jobId:authorization.jobId,outreachAuthorizationId:id}},dedupeKey:`outreach:${id}:scheduled:${at}`});return this.getOutreachAuthorization(id);}
  listDueOutreachAuthorizations({at=this.now(),limit=5}={}){return this.db.prepare("SELECT * FROM outreach_authorizations WHERE status='APPROVED_OUTREACH' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at,id LIMIT ?").all(new Date(at).toISOString(),Math.max(1,Number(limit)||5)).map(row=>this._outreachAuthorizationRow(row));}
  _outreachExecutionRow(r){return r?{id:r.id,idempotencyKey:r.idempotency_key,authorizationId:r.authorization_id,jobId:r.job_id,contactId:r.contact_id,channel:r.channel,messageVersion:r.message_version,messageHash:r.message_hash,sender:r.sender,recipient:r.recipient||'',subject:r.subject||'',provider:r.provider||'',providerMessageId:r.provider_message_id||null,providerThreadId:r.provider_thread_id||null,conversationUrl:r.conversation_url||'',scheduledAt:r.scheduled_at||null,sentAt:r.sent_at||null,lastVerifiedAt:r.last_verified_at||null,responseAt:r.response_at||null,outcome:r.outcome||'UNKNOWN',attemptCount:Number(r.attempt_count||0),status:r.status,providerConfirmation:JSON.parse(r.provider_confirmation_json),blocker:JSON.parse(r.blocker_json),startedAt:r.started_at,finishedAt:r.finished_at,createdAt:r.created_at,updatedAt:r.updated_at}:null;}
  getOutreachExecutionByAuthorization(id){return this._outreachExecutionRow(this.db.prepare('SELECT * FROM outreach_executions WHERE authorization_id=?').get(requiredText(id,'outreachAuthorizationId')));}
  listOutreachExecutions({jobId=null,status=null}={}){return this.db.prepare('SELECT * FROM outreach_executions WHERE (? IS NULL OR job_id=?) AND (? IS NULL OR status=?) ORDER BY created_at,id').all(jobId,jobId,status,status).map(row=>this._outreachExecutionRow(row));}
  beginOutreachExecution(authorizationId,{sender,provider=''}={}){const authorization=this.getOutreachAuthorization(authorizationId);if(!authorization)throw new Error('unknown outreach authorization');const existing=this.getOutreachExecutionByAuthorization(authorizationId);if(existing)return existing;if(authorization.status!=='APPROVED_OUTREACH')throw new Error('outreach authorization is not current');const plan=authorization.outreachPlan,key=hashStable(`${authorization.jobId}:${plan.contactId||''}:${plan.channel}:${plan.version}:${plan.hash}:${authorization.id}`),id=`outreach-execution-${key}`,now=this.now();this.db.prepare(`INSERT INTO outreach_executions(id,idempotency_key,authorization_id,job_id,contact_id,channel,message_version,message_hash,sender,recipient,subject,provider,scheduled_at,status,attempt_count,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'EXECUTING',1,?,?,?)`).run(id,key,authorization.id,authorization.jobId,plan.contactId,plan.channel,requiredText(plan.version,'message version'),requiredText(plan.hash,'message hash'),requiredText(sender,'sender'),plan.recipient||'',plan.subject||'',provider,authorization.scheduledAt,now,now,now);this.recordWorkflowEvent({eventType:'OUTREACH_STARTED',aggregateType:'OUTREACH',aggregateId:id,correlationId:this._eventCorrelationForJob(authorization.jobId,`outreach:${id}`),occurredAt:now,source:'outreach_execution',actorType:'SYSTEM',payload:{channel:plan.channel,attempt:1},metadata:{refs:{jobId:authorization.jobId,outreachAuthorizationId:authorization.id,outreachExecutionId:id}},dedupeKey:`outreach:${id}:started`});return this.getOutreachExecutionByAuthorization(authorization.id);}
  finishOutreachExecution(executionId,{status,confirmation={},blocker={}}={}){const next=requiredText(status,'outreach status').toUpperCase(),now=this.now();const current=this._outreachExecutionRow(this.db.prepare('SELECT * FROM outreach_executions WHERE id=?').get(requiredText(executionId,'outreachExecutionId')));if(!current)throw new Error('unknown outreach execution');if(current.status==='SENT')return current;const sentAt=next==='SENT'?(confirmation.sentAt||now):null;this.db.prepare('UPDATE outreach_executions SET status=?,provider_confirmation_json=?,blocker_json=?,provider=?,provider_message_id=?,provider_thread_id=?,conversation_url=?,sent_at=?,last_verified_at=?,finished_at=?,updated_at=? WHERE id=?').run(next,json(confirmation),json(blocker),confirmation.provider||current.provider||'',confirmation.messageId||confirmation.id||null,confirmation.threadId||null,confirmation.conversationUrl||confirmation.url||'',sentAt,now,['SENT','FAILED','CANCELLED'].includes(next)?now:null,now,current.id);this.db.prepare('UPDATE outreach_authorizations SET status=?,updated_at=? WHERE id=?').run(next,now,current.authorizationId);const eventType=next==='SENT'?'OUTREACH_SENT':next==='VERIFICATION_REQUIRED'?'OUTREACH_VERIFICATION_REQUIRED':next==='NEEDS_HUMAN'&&blocker?.code==='EXTERNAL_ACTION_REQUIRED'?'OUTREACH_EXTERNAL_ACTION_REQUIRED':next==='FAILED'?'OUTREACH_FAILED':null;if(eventType)this.recordWorkflowEvent({eventType,aggregateType:'OUTREACH',aggregateId:current.id,correlationId:this._eventCorrelationForJob(current.jobId,`outreach:${current.id}`),occurredAt:now,source:'outreach_execution',actorType:'SYSTEM',payload:{channel:current.channel,status:next,providerMessageId:confirmation.messageId||confirmation.id||null,blockerCode:blocker.code||null},metadata:{refs:{jobId:current.jobId,outreachAuthorizationId:current.authorizationId,outreachExecutionId:current.id}},dedupeKey:`outreach:${current.id}:${eventType}`});return this.getOutreachExecutionByAuthorization(current.authorizationId);}
  recordOutreachResponse(executionId,{responseAt=this.now(),providerMessageId=null,outcome='REPLIED'}={}){const current=this._outreachExecutionRow(this.db.prepare('SELECT * FROM outreach_executions WHERE id=?').get(requiredText(executionId,'outreachExecutionId')));if(!current||current.status!=='SENT')throw new Error('sent outreach execution is required');const at=new Date(responseAt).toISOString();this.db.prepare('UPDATE outreach_executions SET response_at=?,outcome=?,last_verified_at=?,updated_at=? WHERE id=?').run(at,outcome,at,at,current.id);this.recordWorkflowEvent({eventType:'OUTREACH_RESPONSE_RECEIVED',aggregateType:'OUTREACH',aggregateId:current.id,correlationId:this._eventCorrelationForJob(current.jobId,`outreach:${current.id}`),occurredAt:at,source:'outreach_execution',actorType:'EXTERNAL_PLATFORM',payload:{outcome,providerMessageId},metadata:{refs:{jobId:current.jobId,outreachExecutionId:current.id}},dedupeKey:`outreach:${current.id}:response:${providerMessageId||at}`});return this._outreachExecutionRow(this.db.prepare('SELECT * FROM outreach_executions WHERE id=?').get(current.id));}
  _applicationExecutionRow(r){return r?{id:r.id,idempotencyKey:r.idempotency_key,authorizationId:r.authorization_id,jobId:r.job_id,status:r.status,primaryChannel:r.primary_channel,secondaryChannel:r.secondary_channel,executionMode:r.execution_mode||'GENERIC_BROWSER',batchId:r.batch_id||null,mutationState:r.mutation_state||'PRE_SUBMIT',sessionContext:JSON.parse(r.session_context_json||'{}'),currentStage:r.current_stage,confirmation:JSON.parse(r.confirmation_json),blocker:JSON.parse(r.blocker_json),outreach:JSON.parse(r.outreach_json),startedAt:r.started_at,finishedAt:r.finished_at,createdAt:r.created_at,updatedAt:r.updated_at}:null;}
  getApplicationExecution(id){return this._applicationExecutionRow(this.db.prepare('SELECT * FROM application_executions WHERE id=?').get(requiredText(id,'executionId')));}
  getApplicationExecutionByAuthorization(id){return this._applicationExecutionRow(this.db.prepare('SELECT * FROM application_executions WHERE authorization_id=?').get(requiredText(id,'authorizationId')));}
  listApplicationExecutions({jobId=null,status=null}={}){return this.db.prepare('SELECT * FROM application_executions WHERE (? IS NULL OR job_id=?) AND (? IS NULL OR status=?) ORDER BY created_at,id').all(jobId,jobId,status,status).map(r=>this._applicationExecutionRow(r));}
  beginApplicationExecution(authorizationId,{executionMode=null,batchId=null}={}){const authorization=this.getApplicationExecutionAuthorization(authorizationId);if(!authorization)throw new Error('unknown application authorization');const existing=this.getApplicationExecutionByAuthorization(authorizationId);if(existing){if(batchId&&!existing.batchId)this.db.prepare('UPDATE application_executions SET batch_id=?,updated_at=? WHERE id=?').run(batchId,this.now(),existing.id);return this.getApplicationExecution(existing.id);}if(authorization.status!=='APPROVED_TO_APPLY')throw new Error('authorization is not approved');const planMode=executionMode||authorization.executionPlan.executionMode||'GENERIC_BROWSER',mode=planMode==='NATIVE'?'NATIVE':planMode==='MANUAL_SECURITY_BOUNDARY'?'MANUAL_SECURITY_BOUNDARY':'GENERIC_BROWSER';const key=hashStable(`${authorization.jobId}:${authorization.executionPlanHash}:${authorization.decisionActionId}:4.3.3`),id=`application-execution-${key}`,now=this.now();this.db.transaction(()=>{this.db.prepare(`INSERT INTO application_executions(id,idempotency_key,authorization_id,job_id,status,primary_channel,secondary_channel,execution_mode,batch_id,current_stage,started_at,created_at,updated_at) VALUES(?,?,?,?,'EXECUTING',?,?,?,?, 'PREFLIGHT',?,?,?)`).run(id,key,authorization.id,authorization.jobId,authorization.executionPlan.primaryChannel,authorization.executionPlan.secondaryChannel,mode,batchId,now,now,now);this.db.prepare("UPDATE application_execution_authorizations SET status='EXECUTING',updated_at=? WHERE id=?").run(now,authorization.id);const bridgeId=randomUUID();this.db.prepare(`INSERT INTO application_execution_events(id,execution_id,from_status,to_status,stage,reason,evidence_json,occurred_at) VALUES(?,?, 'APPROVED_TO_APPLY','EXECUTING','PREFLIGHT','execution_started','{}',?)`).run(bridgeId,id,now);const approved=this.db.prepare("SELECT event_id,correlation_id FROM workflow_events WHERE dedupe_key=?").get(`application:${authorization.id}:approved`);this.recordWorkflowEvent({eventType:'APPLICATION_EXECUTION_STARTED',aggregateType:'APPLICATION',aggregateId:id,correlationId:batchId||approved?.correlation_id||this._eventCorrelationForJob(authorization.jobId,`application:${id}`),causationId:approved?.event_id||authorization.id,occurredAt:now,source:'application_execution',actorType:'SYSTEM',payload:{status:'EXECUTING',primaryChannel:authorization.executionPlan.primaryChannel,executionMode:mode},metadata:{refs:{jobId:authorization.jobId,applicationId:id,authorizationId:authorization.id,batchId,bridgeEventId:bridgeId}},dedupeKey:`application:${id}:started`});})();return this.getApplicationExecution(id);}

  resumePreSubmitApplicationExecution(executionId,{batchId=null,reason='safe pre-submit recovery'}={}){const current=this.getApplicationExecution(executionId);if(!current)throw new Error('unknown application execution');if(current.status==='APPLIED'||current.mutationState!=='PRE_SUBMIT')throw new Error('only an unsubmitted application execution can resume');const now=this.now();this.db.transaction(()=>{this.db.prepare("UPDATE application_executions SET status='EXECUTING',current_stage='PREFLIGHT',blocker_json='{}',confirmation_json='{}',batch_id=COALESCE(?,batch_id),finished_at=NULL,updated_at=? WHERE id=?").run(batchId,now,current.id);this.db.prepare("UPDATE application_execution_authorizations SET status='EXECUTING',updated_at=? WHERE id=?").run(now,current.authorizationId);this.db.prepare(`INSERT INTO application_execution_events(id,execution_id,from_status,to_status,stage,reason,evidence_json,occurred_at) VALUES(?,?,?,'EXECUTING','PREFLIGHT',?,'{}',?)`).run(randomUUID(),current.id,current.status,requiredText(reason,'reason'),now);})();return this.getApplicationExecution(current.id);}

  markApplicationMutationState(executionId,mutationState,context={}){const id=requiredText(executionId,'executionId'),state=requiredText(mutationState,'mutationState').toUpperCase(),allowed=new Set(['PRE_SUBMIT','SUBMIT_INTENT_RECORDED','SUBMIT_ATTEMPTED','POST_SUBMIT','VERIFICATION_UNKNOWN']);if(!allowed.has(state))throw new TypeError('invalid application mutation state');const current=this.getApplicationExecution(id);if(!current)throw new Error('unknown application execution');const order={PRE_SUBMIT:0,SUBMIT_INTENT_RECORDED:1,SUBMIT_ATTEMPTED:2,POST_SUBMIT:3,VERIFICATION_UNKNOWN:3};if(order[state]<order[current.mutationState]||current.mutationState==='VERIFICATION_UNKNOWN')return current;this.db.prepare('UPDATE application_executions SET mutation_state=?,session_context_json=?,updated_at=? WHERE id=?').run(state,json({...current.sessionContext,...context}),this.now(),id);return this.getApplicationExecution(id);}
  recordApplicationExecutionStep(executionId,{stepKey,stepType,phase='PRE_SUBMIT',evidence={}}={}){const id=requiredText(executionId,'executionId'),key=requiredText(stepKey,'stepKey'),now=this.now();this.db.prepare(`INSERT OR IGNORE INTO application_execution_steps(id,execution_id,step_key,step_type,phase,evidence_json,occurred_at) VALUES(?,?,?,?,?,?,?)`).run(`application-step-${hashStable(`${id}:${key}`)}`,id,key,requiredText(stepType,'stepType'),requiredText(phase,'phase'),json(evidence),now);return this.db.prepare('SELECT * FROM application_execution_steps WHERE execution_id=? AND step_key=?').get(id,key);}
  listApplicationExecutionSteps(executionId){return this.db.prepare('SELECT * FROM application_execution_steps WHERE execution_id=? ORDER BY occurred_at,rowid').all(requiredText(executionId,'executionId')).map(row=>({id:row.id,executionId:row.execution_id,stepKey:row.step_key,stepType:row.step_type,phase:row.phase,evidence:JSON.parse(row.evidence_json),occurredAt:row.occurred_at}));}

  _humanHandoffRow(r){return r?{id:r.id,executionId:r.execution_id,jobId:r.job_id,batchId:r.batch_id||null,handoffType:r.handoff_type,status:r.status,resumeStatus:r.resume_status,action:r.action,instruction:r.instruction,progress:r.progress,openUrl:r.open_url||'',questions:JSON.parse(r.questions_json||'[]'),evidence:JSON.parse(r.evidence_json||'{}'),session:JSON.parse(r.session_json||'{}'),createdAt:r.created_at,updatedAt:r.updated_at,handoffResolvedAt:r.handoff_resolved_at||null,resumeStartedAt:r.resume_started_at||null,resumeCompletedAt:r.resume_completed_at||null,resumeResult:JSON.parse(r.resume_result_json||'{}')}:null;}
  getHumanHandoff(id){return this._humanHandoffRow(this.db.prepare('SELECT * FROM human_handoffs WHERE id=?').get(requiredText(id,'handoffId')));}
  getActiveHumanHandoffForExecution(executionId){return this._humanHandoffRow(this.db.prepare("SELECT * FROM human_handoffs WHERE execution_id=? AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1").get(requiredText(executionId,'executionId')));}
  listHumanHandoffs({status=null,jobId=null,batchId=null}={}){return this.db.prepare('SELECT * FROM human_handoffs WHERE (? IS NULL OR status=?) AND (? IS NULL OR job_id=?) AND (? IS NULL OR batch_id=?) ORDER BY created_at,id').all(status,status,jobId,jobId,batchId,batchId).map(row=>this._humanHandoffRow(row));}
  createHumanHandoff(input={}){const execution=this.getApplicationExecution(input.executionId);if(!execution)throw new Error('unknown application execution');const existing=this.getActiveHumanHandoffForExecution(execution.id);const now=this.now(),id=existing?.id||`human-handoff-${hashStable(`${execution.id}:${input.handoffType}:${JSON.stringify(input.questions||[])}`)}`;this.db.prepare(`INSERT INTO human_handoffs(id,execution_id,job_id,batch_id,handoff_type,status,resume_status,action,instruction,progress,open_url,questions_json,evidence_json,session_json,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE','PAUSED_FOR_HUMAN',?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET handoff_type=excluded.handoff_type,status='ACTIVE',resume_status='PAUSED_FOR_HUMAN',action=excluded.action,instruction=excluded.instruction,progress=excluded.progress,open_url=excluded.open_url,questions_json=excluded.questions_json,evidence_json=excluded.evidence_json,session_json=excluded.session_json,updated_at=excluded.updated_at`).run(id,execution.id,execution.jobId,input.batchId||execution.batchId||null,requiredText(input.handoffType,'handoffType'),requiredText(input.action,'handoff action'),requiredText(input.instruction,'handoff instruction'),requiredText(input.progress,'handoff progress'),input.openUrl||null,json(input.questions||[]),json(input.evidence||{}),json(input.session||{}),now,now);const handoff=this.getHumanHandoff(id);this.db.prepare('UPDATE application_executions SET session_context_json=?,updated_at=? WHERE id=?').run(json({...execution.sessionContext,handoffId:id,handoffSession:handoff.session}),now,execution.id);this.recordWorkflowEvent({eventType:'HUMAN_HANDOFF_CREATED',aggregateType:'APPLICATION',aggregateId:execution.id,correlationId:input.batchId||this._eventCorrelationForJob(execution.jobId,`handoff:${id}`),source:'application_execution',actorType:'SYSTEM',payload:{handoffId:id,handoffType:handoff.handoffType,questionCount:handoff.questions.length,progress:handoff.progress},metadata:{refs:{jobId:execution.jobId,applicationId:execution.id,handoffId:id,batchId:input.batchId||execution.batchId}},dedupeKey:`human-handoff:${id}:created`});return handoff;}
  resolveHumanHandoff(id,{result={},actorType='HUMAN',actorId='sheet-user'}={}){const handoff=this.getHumanHandoff(id);if(!handoff||handoff.status!=='ACTIVE')return handoff;const now=this.now();this.db.prepare("UPDATE human_handoffs SET status='RESOLVED',handoff_resolved_at=?,updated_at=?,resume_result_json=? WHERE id=?").run(now,now,json(result),handoff.id);this.recordWorkflowEvent({eventType:'HUMAN_HANDOFF_RESOLVED',aggregateType:'APPLICATION',aggregateId:handoff.executionId,correlationId:handoff.batchId||this._eventCorrelationForJob(handoff.jobId,`handoff:${handoff.id}`),source:actorType==='HUMAN'?'sheet':'application_execution',actorType,actorId,payload:{handoffId:handoff.id,handoffType:handoff.handoffType},metadata:{refs:{jobId:handoff.jobId,applicationId:handoff.executionId,handoffId:handoff.id,batchId:handoff.batchId}},dedupeKey:`human-handoff:${handoff.id}:resolved`});return this.getHumanHandoff(id);}
  startHumanHandoffResume(id){const handoff=this.getHumanHandoff(id);if(!handoff)throw new Error('unknown human handoff');const now=this.now();this.db.prepare("UPDATE human_handoffs SET resume_status='RESUMING',resume_started_at=COALESCE(resume_started_at,?),updated_at=? WHERE id=?").run(now,now,id);this.recordWorkflowEvent({eventType:'APPLICATION_RESUME_STARTED',aggregateType:'APPLICATION',aggregateId:handoff.executionId,correlationId:handoff.batchId||this._eventCorrelationForJob(handoff.jobId,`handoff:${id}`),source:'application_execution',actorType:'SYSTEM',payload:{handoffId:id},metadata:{refs:{jobId:handoff.jobId,applicationId:handoff.executionId,handoffId:id,batchId:handoff.batchId}},dedupeKey:`human-handoff:${id}:resume-started`});return this.getHumanHandoff(id);}
  finishHumanHandoffResume(id,{status='RESUMED',result={}}={}){const handoff=this.getHumanHandoff(id);if(!handoff)throw new Error('unknown human handoff');const next=requiredText(status,'resume status').toUpperCase(),now=this.now();if(!['PAUSED_FOR_HUMAN','RESUMED','FAILED'].includes(next))throw new TypeError('invalid resume status');this.db.prepare('UPDATE human_handoffs SET resume_status=?,resume_completed_at=?,resume_result_json=?,updated_at=? WHERE id=?').run(next,next==='PAUSED_FOR_HUMAN'?null:now,json(result),now,id);if(next==='RESUMED')this.recordWorkflowEvent({eventType:'APPLICATION_RESUMED',aggregateType:'APPLICATION',aggregateId:handoff.executionId,correlationId:handoff.batchId||this._eventCorrelationForJob(handoff.jobId,`handoff:${id}`),source:'application_execution',actorType:'SYSTEM',payload:{handoffId:id,resultStatus:result.status||'CONTINUED'},metadata:{refs:{jobId:handoff.jobId,applicationId:handoff.executionId,handoffId:id,batchId:handoff.batchId}},dedupeKey:`human-handoff:${id}:resumed`});return this.getHumanHandoff(id);}

  _platformAccountRow(r){return r?{id:r.id,platformKey:r.platform_key,accountEmail:r.account_email,profileIdentity:r.profile_identity,status:r.status,credentialReference:r.credential_reference||null,createdAt:r.created_at,lastVerifiedAt:r.last_verified_at||null,applicationHistory:JSON.parse(r.application_history_json||'[]'),metadata:JSON.parse(r.metadata_json||'{}'),updatedAt:r.updated_at}:null;}
  getPlatformAccount({platformKey,accountEmail}={}){return this._platformAccountRow(this.db.prepare('SELECT * FROM platform_accounts WHERE platform_key=? AND account_email=?').get(requiredText(platformKey,'platformKey'),requiredText(accountEmail,'accountEmail').toLowerCase()));}
  upsertPlatformAccount({platformKey,accountEmail,profileIdentity='Jorge',status='PENDING_VERIFICATION',credentialReference=null,metadata={}}={}){const platform=requiredText(platformKey,'platformKey').toLowerCase(),email=requiredText(accountEmail,'accountEmail').toLowerCase(),now=this.now(),id=`platform-account-${hashStable(`${platform}:${email}`)}`;this.db.prepare(`INSERT INTO platform_accounts(id,platform_key,account_email,profile_identity,status,credential_reference,created_at,metadata_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(platform_key,account_email) DO UPDATE SET profile_identity=excluded.profile_identity,status=excluded.status,credential_reference=COALESCE(excluded.credential_reference,platform_accounts.credential_reference),metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).run(id,platform,email,requiredText(profileIdentity,'profileIdentity'),requiredText(status,'status'),credentialReference,now,json(metadata),now);return this.getPlatformAccount({platformKey:platform,accountEmail:email});}
  verifyPlatformAccount(accountId,{evidence={},verifiedAt=this.now(),executionId=null}={}){const account=this._platformAccountRow(this.db.prepare('SELECT * FROM platform_accounts WHERE id=?').get(requiredText(accountId,'accountId')));if(!account)throw new Error('unknown platform account');const history=[...account.applicationHistory];if(executionId&&!history.includes(executionId))history.push(executionId);this.db.prepare("UPDATE platform_accounts SET status='ACTIVE',last_verified_at=?,application_history_json=?,metadata_json=?,updated_at=? WHERE id=?").run(verifiedAt,json(history),json({...account.metadata,lastVerificationEvidence:evidence}),this.now(),account.id);return this._platformAccountRow(this.db.prepare('SELECT * FROM platform_accounts WHERE id=?').get(account.id));}
  listPlatformAccounts(){return this.db.prepare('SELECT * FROM platform_accounts ORDER BY platform_key,account_email').all().map(row=>this._platformAccountRow(row));}

  beginApplicationBatch({correlationId,source='SYNC_JOBS'}={}){const correlation=requiredText(correlationId,'correlationId'),existing=this.db.prepare('SELECT * FROM application_execution_batches WHERE correlation_id=?').get(correlation);if(existing)return this._applicationBatchRow(existing);const now=this.now(),id=`application-batch-${hashStable(correlation)}`;this.db.prepare("INSERT INTO application_execution_batches(id,correlation_id,source,status,started_at,created_at,updated_at) VALUES(?,?,?,'RUNNING',?,?,?)").run(id,correlation,requiredText(source,'source'),now,now,now);return this._applicationBatchRow(this.db.prepare('SELECT * FROM application_execution_batches WHERE id=?').get(id));}
  _applicationBatchRow(r){return r?{id:r.id,correlationId:r.correlation_id,source:r.source,status:r.status,startedAt:r.started_at,completedAt:r.completed_at||null,summary:JSON.parse(r.summary_json||'{}'),notificationDeliveryId:r.notification_delivery_id||null,createdAt:r.created_at,updatedAt:r.updated_at}:null;}
  finishApplicationBatch(batchId,{status='COMPLETED',summary={},notificationDeliveryId=null}={}){const now=this.now();this.db.prepare('UPDATE application_execution_batches SET status=?,completed_at=?,summary_json=?,notification_delivery_id=?,updated_at=? WHERE id=?').run(requiredText(status,'status'),now,json(summary),notificationDeliveryId,now,requiredText(batchId,'batchId'));return this._applicationBatchRow(this.db.prepare('SELECT * FROM application_execution_batches WHERE id=?').get(batchId));}
  finishApplicationExecution(executionId,{status,stage,reason,confirmation={},blocker={},outreach={}}={}){const id=requiredText(executionId,'executionId'),next=requiredText(status,'status').toUpperCase(),now=this.now();const current=this.getApplicationExecution(id);if(!current)throw new Error('unknown application execution');if(current.status==='APPLIED')return current;if(next==='APPLIED'&&!confirmation?.id&&!confirmation?.url&&!confirmation?.messageId)throw new Error('APPLIED requires observable confirmation');const finishedAt=next==='APPLIED'&&confirmation?.observedAt?iso(confirmation.observedAt,'confirmation.observedAt'):now;this.db.transaction(()=>{this.db.prepare('UPDATE application_executions SET status=?,current_stage=?,confirmation_json=?,blocker_json=?,outreach_json=?,finished_at=?,updated_at=? WHERE id=?').run(next,requiredText(stage,'stage'),json(confirmation),json(blocker),json(outreach),['APPLIED','FAILED','CANCELLED'].includes(next)?finishedAt:null,now,id);this.db.prepare('UPDATE application_execution_authorizations SET status=?,updated_at=? WHERE id=?').run(next,now,current.authorizationId);const bridgeId=randomUUID();this.db.prepare(`INSERT INTO application_execution_events(id,execution_id,from_status,to_status,stage,reason,evidence_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)`).run(bridgeId,id,current.status,next,stage,requiredText(reason,'reason'),json({confirmation,blocker,outreach}),now);const prior=this.db.prepare("SELECT event_id,correlation_id FROM workflow_events WHERE aggregate_type='APPLICATION' AND aggregate_id=? ORDER BY occurred_at DESC,event_id DESC LIMIT 1").get(id);let cause=prior?.event_id||bridgeId;if(['CONFIRMATION','CONFIRMED'].includes(String(stage).toUpperCase())){const attempted=this.recordWorkflowEvent({eventType:'APPLICATION_SUBMIT_ATTEMPTED',aggregateType:'APPLICATION',aggregateId:id,correlationId:prior?.correlation_id||this._eventCorrelationForJob(current.jobId,`application:${id}`),causationId:cause,occurredAt:now,source:'application_execution',actorType:'SYSTEM',payload:{status:next},metadata:{refs:{jobId:current.jobId,applicationId:id,bridgeEventId:bridgeId}},dedupeKey:`application:${id}:submit-attempt:${bridgeId}`});cause=attempted.event.event_id;}const type=next==='APPLIED'?'APPLICATION_CONFIRMED':next==='NEEDS_HUMAN'&&blocker?.code==='VERIFICATION_UNKNOWN'?'APPLICATION_VERIFICATION_UNKNOWN':next==='NEEDS_HUMAN'?'APPLICATION_NEEDS_HUMAN':next==='FAILED'?'APPLICATION_FAILED':next==='CANCELLED'?'APPLICATION_CANCELLED':null;if(type)this.recordWorkflowEvent({eventType:type,aggregateType:'APPLICATION',aggregateId:id,correlationId:prior?.correlation_id||this._eventCorrelationForJob(current.jobId,`application:${id}`),causationId:cause,occurredAt:now,source:'application_execution',actorType:'SYSTEM',payload:{fromStatus:current.status,toStatus:next,stage,reasonCode:reason,blockerCode:blocker?.code||null,confirmationRef:confirmation?.id||confirmation?.messageId||confirmation?.url||null,observedAt:confirmation?.observedAt||null},metadata:{refs:{jobId:current.jobId,applicationId:id,bridgeEventId:bridgeId}},dedupeKey:`application:${id}:${type}:${bridgeId}`});})();return this.getApplicationExecution(id);}
  getApplicationExecutionEvents(executionId){return this.db.prepare('SELECT * FROM application_execution_events WHERE execution_id=? ORDER BY occurred_at,rowid').all(requiredText(executionId,'executionId')).map(r=>({id:r.id,executionId:r.execution_id,fromStatus:r.from_status,toStatus:r.to_status,stage:r.stage,reason:r.reason,evidence:JSON.parse(r.evidence_json),occurredAt:r.occurred_at}));}
  markCandidateApplied(jobId){const job=requiredText(jobId,'jobId'),now=this.now(),sourceActionId=this.db.prepare('SELECT decision_action_id FROM application_execution_authorizations WHERE job_id=? ORDER BY approved_at DESC LIMIT 1').get(job)?.decision_action_id||`system-confirmed-application:${job}`;this.db.transaction(()=>{this.db.prepare("UPDATE active_candidates SET state='ACTED',state_reason='confirmed_application',updated_at=? WHERE job_id=? AND state IN ('ACTIVE','CARRYOVER')").run(now,job);this.db.prepare(`INSERT INTO human_field_state(entity_type,entity_id,field_name,value_json,source_action_id,updated_at) VALUES('JOB',?,'application_status','\"APPLIED\"',?,?) ON CONFLICT(entity_type,entity_id,field_name) DO UPDATE SET value_json='\"APPLIED\"',source_action_id=excluded.source_action_id,updated_at=excluded.updated_at`).run(job,sourceActionId,now);})();return this.db.prepare('SELECT state,state_reason,updated_at FROM active_candidates WHERE job_id=?').get(job)||{state:'ACTED',state_reason:'confirmed_application',updated_at:now};}

  supersedeApplicationExecutionAuthorization(authorizationId,{reason='STALE_PACKAGE',nextPackageId=null}={}){const authorization=this.getApplicationExecutionAuthorization(authorizationId);if(!authorization)throw new Error('unknown application authorization');if(authorization.status==='APPLIED')throw new Error('applied authorization cannot be superseded');const now=this.now(),execution=this.getApplicationExecutionByAuthorization(authorizationId);this.db.transaction(()=>{if(execution&&execution.status!=='CANCELLED'){this.db.prepare("UPDATE application_executions SET status='CANCELLED',current_stage='AUTHORIZATION',blocker_json=?,finished_at=?,updated_at=? WHERE id=?").run(json({code:'STALE_PACKAGE',nextPackageId}),now,now,execution.id);this.db.prepare(`INSERT INTO application_execution_events(id,execution_id,from_status,to_status,stage,reason,evidence_json,occurred_at) VALUES(?,?,?,'CANCELLED','AUTHORIZATION',?,?,?)`).run(randomUUID(),execution.id,execution.status,requiredText(reason,'reason'),json({code:'STALE_PACKAGE',nextPackageId}),now);}this.db.prepare("UPDATE application_execution_authorizations SET status='CANCELLED',supersession_reason=?,superseded_at=?,updated_at=? WHERE id=?").run(requiredText(reason,'reason'),now,now,authorizationId);})();return this.getApplicationExecutionAuthorization(authorizationId);}

  recordApplicationHumanAnswer({jobId,executionId=null,question,normalizedField,answer,scope='JOB',sourceActionId=null,humanSource='GOOGLE_SHEETS'}={}){
    const job=requiredText(jobId,'jobId'),prompt=requiredText(question,'question'),field=requiredText(normalizedField,'normalizedField');
    const boundedScope=String(scope).toUpperCase()==='GLOBAL'?'GLOBAL':'JOB';
    const key=hashStable(`${job}:${executionId||''}:${field}:${boundedScope}`),id=`application-answer-${key}`,now=this.now();
    this.db.transaction(()=>{this.db.prepare(`INSERT INTO application_human_answers(id,answer_key,job_id,execution_id,question,normalized_field,answer_json,scope,source_action_id,human_source,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(answer_key) DO UPDATE SET question=excluded.question,answer_json=excluded.answer_json,source_action_id=excluded.source_action_id,human_source=excluded.human_source,updated_at=excluded.updated_at`)
      .run(id,key,job,executionId,prompt,field,json(answer),boundedScope,sourceActionId,requiredText(humanSource,'humanSource'),now,now);this.recordWorkflowEvent({eventType:'APPLICATION_HUMAN_ANSWER_PROVIDED',aggregateType:'APPLICATION',aggregateId:executionId||job,correlationId:sourceActionId?this._eventCorrelationForRef(sourceActionId,this._eventCorrelationForJob(job,`human-answer:${id}`)):this._eventCorrelationForJob(job,`human-answer:${id}`),causationId:sourceActionId||id,occurredAt:now,source:'sheet',actorType:'HUMAN',actorId:'sheet-user',payload:{field,answerRef:id},metadata:{refs:{jobId:job,applicationId:executionId||null,applicationFactId:id,humanActionId:sourceActionId}},dedupeKey:`application-answer:${id}:provided`});})();
    return this.listApplicationHumanAnswers({jobId:job}).find(item=>item.id===id);
  }
  listApplicationHumanAnswers({jobId=null,executionId=null}={}){return this.db.prepare(`SELECT * FROM application_human_answers WHERE (? IS NULL OR job_id=?) AND (? IS NULL OR execution_id=?) ORDER BY updated_at DESC,id`).all(jobId,jobId,executionId,executionId).map(r=>({id:r.id,answerKey:r.answer_key,jobId:r.job_id,executionId:r.execution_id,question:r.question,normalizedField:r.normalized_field,answer:JSON.parse(r.answer_json),scope:r.scope,sourceActionId:r.source_action_id,humanSource:r.human_source,createdAt:r.created_at,updatedAt:r.updated_at}));}
  recordApplicationQuestionResolution({executionId,jobId,platformKey='generic',fieldId,question,semanticKey,answer,resolutionType,confidence='HIGH',evidenceRefs=[],scope='JOB',reusable=false,validAsOf=null}={}){const execution=requiredText(executionId,'executionId'),job=requiredText(jobId,'jobId'),semantic=requiredText(semanticKey,'semanticKey'),field=requiredText(fieldId||semantic,'fieldId'),prompt=requiredText(question||semantic,'question'),type=requiredText(resolutionType,'resolutionType'),now=this.now(),resolutionKey=hashStable(`${execution}:${field}:${semantic}`),id=`application-question-resolution-${resolutionKey}`;this.db.prepare(`INSERT INTO application_question_resolutions(id,resolution_key,execution_id,job_id,platform_key,field_id,question,semantic_key,answer_json,resolution_type,confidence,evidence_json,scope,reusable,valid_as_of,resolved_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(resolution_key) DO UPDATE SET question=excluded.question,answer_json=excluded.answer_json,resolution_type=excluded.resolution_type,confidence=excluded.confidence,evidence_json=excluded.evidence_json,scope=excluded.scope,reusable=excluded.reusable,valid_as_of=excluded.valid_as_of,updated_at=excluded.updated_at`).run(id,resolutionKey,execution,job,requiredText(platformKey,'platformKey'),field,prompt,semantic,json(answer),type,requiredText(confidence,'confidence'),json(evidenceRefs,[]),requiredText(scope,'scope'),reusable?1:0,validAsOf,now,now);return this.getApplicationQuestionResolution(id);}
  _applicationQuestionResolutionRow(r){return r?{id:r.id,resolutionKey:r.resolution_key,executionId:r.execution_id,jobId:r.job_id,platformKey:r.platform_key,fieldId:r.field_id,question:r.question,semanticKey:r.semantic_key,answer:JSON.parse(r.answer_json),resolutionType:r.resolution_type,confidence:r.confidence,evidenceRefs:JSON.parse(r.evidence_json||'[]'),scope:r.scope,reusable:Boolean(r.reusable),validAsOf:r.valid_as_of||null,resolvedAt:r.resolved_at,updatedAt:r.updated_at}:null;}
  getApplicationQuestionResolution(id){return this._applicationQuestionResolutionRow(this.db.prepare('SELECT * FROM application_question_resolutions WHERE id=?').get(requiredText(id,'resolutionId')));}
  listApplicationQuestionResolutions({executionId=null,jobId=null,semanticKey=null,reusable=null}={}){return this.db.prepare(`SELECT * FROM application_question_resolutions WHERE (? IS NULL OR execution_id=?) AND (? IS NULL OR job_id=?) AND (? IS NULL OR semantic_key=?) AND (? IS NULL OR reusable=?) ORDER BY updated_at DESC,id`).all(executionId,executionId,jobId,jobId,semanticKey,semanticKey,reusable==null?null:(reusable?1:0),reusable==null?null:(reusable?1:0)).map(row=>this._applicationQuestionResolutionRow(row));}
  hasWorkflowRequestReceipt(requestType,requestedAt){return Boolean(this.db.prepare('SELECT 1 FROM workflow_request_receipts WHERE request_type=? AND requested_at=?').get(requiredText(requestType,'requestType'),requiredText(requestedAt,'requestedAt')));}
  recordWorkflowRequestReceipt({requestType,requestedAt,status,result={}}={}){const at=this.now();this.db.prepare(`INSERT INTO workflow_request_receipts(request_type,requested_at,status,result_json,processed_at) VALUES(?,?,?,?,?) ON CONFLICT(request_type,requested_at) DO UPDATE SET status=excluded.status,result_json=excluded.result_json,processed_at=excluded.processed_at`).run(requiredText(requestType,'requestType'),requiredText(requestedAt,'requestedAt'),requiredText(status,'status'),json(result),at);return{requestType,requestedAt,status,result,processedAt:at};}

  _workflowCommandRow(row) {
    if (!row) return null;
    return {
      commandId: row.command_id, commandType: row.command_type, correlationId: row.correlation_id,
      source: row.source, requestedAt: row.requested_at, receivedAt: row.received_at,
      startedAt: row.started_at, completedAt: row.completed_at, status: row.status,
      attemptCount: row.attempt_count, payloadHash: row.payload_hash,
      envelope: JSON.parse(row.envelope_json), resultSummary: row.result_summary,
      errorCode: row.error_code, errorMessage: row.error_message,
      pubsubMessageId: row.pubsub_message_id, version: row.version,
    };
  }

  receiveWorkflowCommand({ envelope, payloadHash, pubsubMessageId = null } = {}) {
    const commandId = requiredText(envelope?.command_id, 'command_id');
    const commandType = requiredText(envelope?.command_type, 'command_type');
    if (!['jobs.sync', 'communities.sync'].includes(commandType)) throw new TypeError('unsupported command_type');
    const requestedAt = iso(envelope.requested_at, 'requested_at');
    const receivedAt = this.now();
    const correlationId = requiredText(envelope.correlation_id, 'correlation_id');
    let inserted;
    this.db.transaction(() => {
      inserted = this.db.prepare(`INSERT OR IGNORE INTO workflow_commands(
        command_id,command_type,correlation_id,source,requested_at,received_at,status,payload_hash,envelope_json,pubsub_message_id,version
      ) VALUES(?,?,?,?,?,?,'RECEIVED',?,?,?,?)`).run(
        commandId, commandType, correlationId, requiredText(envelope.source, 'source'), requestedAt, receivedAt,
        requiredText(payloadHash, 'payloadHash'), json(envelope), pubsubMessageId || null,
        requiredText(envelope.command_version, 'command_version'));
      if (inserted.changes) this.recordWorkflowEvent({ eventType:'COMMAND_RECEIVED', aggregateType:'COMMAND', aggregateId:commandId, correlationId, causationId:commandId, commandId, occurredAt:receivedAt, source:'command_subscriber', actorType:'SYSTEM', actorId:'native-mac-subscriber', payload:{ commandType }, metadata:{ refs:{ pubsubMessageId } }, dedupeKey:`command:${commandId}:received` });
    })();
    const command = this.getWorkflowCommand(commandId);
    if (!inserted.changes && command.payloadHash !== payloadHash) throw new Error('duplicate command_id payload mismatch');
    return { command, duplicate: inserted.changes === 0 };
  }

  getWorkflowCommand(commandId) {
    return this._workflowCommandRow(this.db.prepare('SELECT * FROM workflow_commands WHERE command_id=?').get(requiredText(commandId, 'commandId')));
  }

  listWorkflowCommands({ statuses = [], commandType = null, limit = 100 } = {}) {
    const allowed = new Set(['RECEIVED','PROCESSING','SUCCESS','FAILED','NEEDS_HUMAN','CANCELLED']);
    const normalized = statuses.map(status => String(status).toUpperCase());
    if (normalized.some(status => !allowed.has(status))) throw new TypeError('invalid workflow command status');
    const clauses = [], params = [];
    if (normalized.length) { clauses.push(`status IN (${normalized.map(() => '?').join(',')})`); params.push(...normalized); }
    if (commandType) { clauses.push('command_type=?'); params.push(commandType); }
    params.push(Math.max(1, Math.min(1000, Number(limit) || 100)));
    return this.db.prepare(`SELECT * FROM workflow_commands ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY requested_at DESC, command_id LIMIT ?`).all(...params).map(row => this._workflowCommandRow(row));
  }

  claimWorkflowCommand(commandId) {
    return this.db.transaction(() => {
      const current = this.getWorkflowCommand(commandId);
      if (!current) throw new Error(`unknown workflow command: ${commandId}`);
      if (!['RECEIVED','PROCESSING'].includes(current.status)) return { command: current, claimed: false };
      const startedAt = this.now();
      this.db.prepare(`UPDATE workflow_commands SET status='PROCESSING',started_at=COALESCE(started_at,?),attempt_count=attempt_count+1,error_code=NULL,error_message=NULL WHERE command_id=?`).run(startedAt, commandId);
      const command = this.getWorkflowCommand(commandId);
      const receivedEvent=this.db.prepare("SELECT event_id FROM workflow_events WHERE dedupe_key=?").get(`command:${commandId}:received`);
      this.recordWorkflowEvent({ eventType:'COMMAND_STARTED', aggregateType:'COMMAND', aggregateId:commandId, correlationId:command.correlationId, causationId:receivedEvent?.event_id||commandId, commandId, occurredAt:startedAt, source:'command_subscriber', actorType:'SYSTEM', actorId:'native-mac-subscriber', payload:{ commandType:command.commandType, attemptCount:command.attemptCount }, dedupeKey:`command:${commandId}:started` });
      return { command, claimed: true };
    })();
  }

  completeWorkflowCommand(commandId, { status = 'SUCCESS', resultSummary = '', errorCode = null, errorMessage = null } = {}) {
    const normalized = String(status).toUpperCase();
    if (!['SUCCESS','FAILED','NEEDS_HUMAN','CANCELLED'].includes(normalized)) throw new TypeError('invalid terminal workflow command status');
    const id=requiredText(commandId, 'commandId'); const completedAt=this.now();
    this.db.transaction(()=>{
      this.db.prepare(`UPDATE workflow_commands SET status=?,completed_at=?,result_summary=?,error_code=?,error_message=? WHERE command_id=?`).run(normalized, completedAt, String(resultSummary || ''), errorCode || null, errorMessage ? String(errorMessage).slice(0, 1000) : null, id);
      const command=this.getWorkflowCommand(id); const failed=normalized==='FAILED';
      const latestCause=this.db.prepare("SELECT event_id FROM workflow_events WHERE correlation_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1").get(command.correlationId);
      this.recordWorkflowEvent({ eventType:failed?'COMMAND_FAILED':'COMMAND_COMPLETED', aggregateType:'COMMAND', aggregateId:id, correlationId:command.correlationId, causationId:latestCause?.event_id||id, commandId:id, occurredAt:completedAt, source:'command_subscriber', actorType:'SYSTEM', actorId:'native-mac-subscriber', payload:{ status:normalized, resultSummary:String(resultSummary||''), errorCode:errorCode||null }, dedupeKey:`command:${id}:${failed?'failed':'completed'}` });
    })();
    return this.getWorkflowCommand(commandId);
  }

  recordApplicationEnrichmentEvidence(requestId, evidence = []) {
    const request = this.getEnrichmentRequest(requestId); if (!request) throw new Error(`unknown enrichment request: ${requestId}`);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO application_enrichment_evidence(id,request_id,job_id,source_url,source_type,fetched_at,
      extraction_method,raw_snippet,raw_hash,normalized_field,value_json,confidence,identity_status,resolver_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const run = this.db.transaction(() => { for (const item of evidence) insert.run(requiredText(item.id,'evidence.id'),requestId,request.jobId,requiredText(item.sourceUrl,'evidence.sourceUrl'),requiredText(item.sourceType,'evidence.sourceType'),iso(item.fetchedAt,'evidence.fetchedAt'),requiredText(item.extractionMethod,'evidence.extractionMethod'),String(item.rawSnippet||''),requiredText(item.rawHash,'evidence.rawHash'),requiredText(item.normalizedField,'evidence.normalizedField'),json(item.value),requiredText(item.confidence,'evidence.confidence').toUpperCase(),item.identityStatus === 'UNCERTAIN' ? 'UNCERTAIN' : 'CONFIRMED',requiredText(item.resolverVersion,'evidence.resolverVersion'),this.now()); }); run();
    return this.getApplicationEnrichmentEvidence(requestId);
  }

  getApplicationEnrichmentEvidence(requestId) {
    return this.db.prepare('SELECT * FROM application_enrichment_evidence WHERE request_id=? ORDER BY created_at,id').all(requiredText(requestId,'requestId')).map(row => ({
      id: row.id, requestId: row.request_id, jobId: row.job_id, sourceUrl: row.source_url, sourceType: row.source_type,
      fetchedAt: row.fetched_at, extractionMethod: row.extraction_method, rawSnippet: row.raw_snippet, rawHash: row.raw_hash,
      normalizedField: row.normalized_field, value: JSON.parse(row.value_json), confidence: row.confidence,
      identityStatus: row.identity_status, resolverVersion: row.resolver_version, createdAt: row.created_at,
    }));
  }

  getHumanFieldState() {
    const rows=this.db.prepare('SELECT entity_type, entity_id, field_name, value_json, updated_at FROM human_field_state ORDER BY entity_type, entity_id, field_name').all();
    rows.push(...this.db.prepare("SELECT 'COMMUNITY' entity_type,community_id entity_id,field_name,value_json,updated_at FROM facebook_community_human_state ORDER BY community_id,field_name").all());
    return rows.map(row => ({
      entityType: row.entity_type, entityId: row.entity_id, field: row.field_name, value: JSON.parse(row.value_json), updatedAt: row.updated_at,
    }));
  }

  recordFacebookCommunities(communities = [], { runId = null } = {}) {
    const now = this.now(); const saved=[];
    const write=this.db.transaction(()=>{for(const item of communities){
      const existing=this.db.prepare('SELECT * FROM facebook_communities WHERE canonical_url=?').get(requiredText(item.canonicalUrl,'community.canonicalUrl'));
      const id=existing?.id||requiredText(item.id,'community.id'); const evidence=json(item.evidence,[]);
      this.db.prepare(`INSERT INTO facebook_communities(id,canonical_url,name,topic,visibility,membership_state,member_count,activity_score,opportunity_score,spam_score,quality_score,recommendation,public_description,language,geography_signals_json,why_it_matters,query,query_reason,query_priority,strategy_revision,candidate_kb_hash,evidence_json,first_seen_at,last_seen_at,last_checked_at,version,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?)
        ON CONFLICT(canonical_url) DO UPDATE SET name=excluded.name,topic=excluded.topic,visibility=excluded.visibility,
          membership_state=CASE WHEN facebook_communities.membership_state IN ('JOINED_CONFIRMED','MONITORING','SKIPPED','REJECTED','LEFT') THEN facebook_communities.membership_state ELSE excluded.membership_state END,
          member_count=excluded.member_count,activity_score=excluded.activity_score,opportunity_score=excluded.opportunity_score,spam_score=excluded.spam_score,quality_score=excluded.quality_score,recommendation=excluded.recommendation,public_description=excluded.public_description,language=excluded.language,geography_signals_json=excluded.geography_signals_json,why_it_matters=excluded.why_it_matters,query=excluded.query,query_reason=excluded.query_reason,query_priority=excluded.query_priority,strategy_revision=excluded.strategy_revision,candidate_kb_hash=excluded.candidate_kb_hash,evidence_json=excluded.evidence_json,last_seen_at=excluded.last_seen_at,version=CASE WHEN facebook_communities.evidence_json!=excluded.evidence_json THEN facebook_communities.version+1 ELSE facebook_communities.version END,updated_at=excluded.updated_at`)
        .run(id,item.canonicalUrl,requiredText(item.name,'community.name'),item.topic||'',item.visibility||'UNKNOWN',item.membershipState||'DISCOVERED',item.memberCount??null,item.activityScore||0,item.opportunityScore||0,item.spamScore||0,item.qualityScore||0,item.recommendation||'UNKNOWN',item.publicDescription||'',item.language||'',json(item.geographySignals,[]),item.whyItMatters||'',item.query||'',item.queryReason||'',item.queryPriority||'',requiredText(item.strategyRevision,'community.strategyRevision'),requiredText(item.candidateKbHash,'community.candidateKbHash'),evidence,now,now,now);
      if(!existing){this.db.prepare(`INSERT INTO facebook_community_events(id,community_id,from_state,to_state,reason,run_id,action_id,evidence_refs_json,occurred_at) VALUES(?,?,NULL,?,'community_discovered',?,NULL,?,?)`).run(randomUUID(),id,item.membershipState||'DISCOVERED',runId,json((item.evidence||[]).map(x=>x.id),[]),now);this.recordWorkflowEvent({eventType:'COMMUNITY_DISCOVERED',aggregateType:'COMMUNITY',aggregateId:id,correlationId:runId||`community:${id}`,causationId:runId||null,occurredAt:now,source:'facebook',actorType:'SYSTEM',payload:{status:item.membershipState||'DISCOVERED'},metadata:{refs:{communityId:id,runId}},dedupeKey:`community:${id}:discovered`});}
      saved.push(this.getFacebookCommunity(id));
    }});write();return saved;
  }

  _facebookCommunityRow(row){if(!row)return null;const verified=row.verification_status&&row.verification_status!=='UNVERIFIED'?row.verification_status:null;return{id:row.id,canonicalUrl:row.canonical_url,name:row.name,topic:row.topic,visibility:row.visibility,membershipState:verified||(row.join_status&&row.join_status!=='NONE'?row.join_status:row.membership_state),baseMembershipState:row.membership_state,joinStatus:row.join_status||'NONE',verificationStatus:row.verification_status||'UNVERIFIED',suppressedAt:row.suppressed_at||null,suppressionReason:row.suppression_reason||null,suppressionActionId:row.suppression_action_id||null,memberCount:row.member_count,activityScore:row.activity_score,opportunityScore:row.opportunity_score,spamScore:row.spam_score,qualityScore:row.quality_score,recommendation:row.recommendation,publicDescription:row.public_description,language:row.language,geographySignals:JSON.parse(row.geography_signals_json),whyItMatters:row.why_it_matters,query:row.query,queryReason:row.query_reason,queryPriority:row.query_priority,strategyRevision:row.strategy_revision,candidateKbHash:row.candidate_kb_hash,evidence:JSON.parse(row.evidence_json),firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at,lastCheckedAt:row.last_checked_at,version:row.version,updatedAt:row.updated_at};}
  getFacebookCommunity(id){return this._facebookCommunityRow(this.db.prepare('SELECT * FROM facebook_communities WHERE id=?').get(requiredText(id,'communityId')));}
  listFacebookCommunities(){return this.db.prepare('SELECT * FROM facebook_communities ORDER BY quality_score DESC,name,id').all().map(row=>this._facebookCommunityRow(row));}
  transitionFacebookCommunity(id,toState,{reason,runId=null,actionId=null,evidenceRefs=[]}={}){const current=this.db.prepare('SELECT * FROM facebook_communities WHERE id=?').get(requiredText(id,'communityId'));if(!current)throw new Error(`unknown Facebook community: ${id}`);const next=requiredText(toState,'toState').toUpperCase();if(current.membership_state===next)return this._facebookCommunityRow(current);const allowed={DISCOVERED:['RECOMMENDED','JOIN_REQUIRED','JOINED_CONFIRMED','SKIPPED','REJECTED','BLOCKED'],RECOMMENDED:['JOIN_REQUIRED','JOINED_CONFIRMED','SKIPPED','REJECTED','BLOCKED'],JOIN_REQUIRED:['JOINED_CONFIRMED','SKIPPED','REJECTED','BLOCKED'],JOINED_CONFIRMED:['MONITORING','LEFT','BLOCKED','SKIPPED','REJECTED'],MONITORING:['JOINED_CONFIRMED','LEFT','BLOCKED','SKIPPED','REJECTED'],SKIPPED:[],REJECTED:[],LEFT:['JOINED_CONFIRMED','SKIPPED','REJECTED'],BLOCKED:['DISCOVERED','JOIN_REQUIRED','JOINED_CONFIRMED','SKIPPED','REJECTED'],UNKNOWN:['DISCOVERED','REJECTED','SKIPPED']};if(!(allowed[current.membership_state]||[]).includes(next))throw new Error(`community cannot transition from ${current.membership_state} to ${next}`);const now=this.now();this.db.transaction(()=>{this.db.prepare('UPDATE facebook_communities SET membership_state=?,last_checked_at=CASE WHEN ?=\'MONITORING\' THEN ? ELSE last_checked_at END,updated_at=? WHERE id=?').run(next,next,now,now,id);const bridgeId=randomUUID();this.db.prepare(`INSERT INTO facebook_community_events(id,community_id,from_state,to_state,reason,run_id,action_id,evidence_refs_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(bridgeId,id,current.membership_state,next,requiredText(reason,'reason'),runId,actionId,json(evidenceRefs,[]),now);const type=next==='JOIN_REQUIRED'?'COMMUNITY_JOIN_REQUESTED':next==='JOINED_CONFIRMED'?'COMMUNITY_JOIN_CONFIRMED':['SKIPPED','REJECTED'].includes(next)?'COMMUNITY_SUPPRESSED':next==='MONITORING'?'COMMUNITY_MONITORING_COMPLETED':next==='BLOCKED'?'COMMUNITY_NEEDS_HUMAN':null;if(type)this.recordWorkflowEvent({eventType:type,aggregateType:'COMMUNITY',aggregateId:id,correlationId:actionId?this._eventCorrelationForRef(actionId,`human-action:${actionId}`):(runId||`community:${id}`),causationId:actionId||bridgeId,occurredAt:now,source:'facebook',actorType:actionId?'HUMAN':'SYSTEM',payload:{fromStatus:current.membership_state,toStatus:next,reasonCode:reason},metadata:{refs:{communityId:id,humanActionId:actionId,runId,bridgeEventId:bridgeId}},dedupeKey:`facebook-transition:${bridgeId}`});})();return this.getFacebookCommunity(id);}
  listFacebookCommunityJoinPlan(){return this.db.prepare(`SELECT c.*,s.source_action_id authorization_action_id,s.updated_at authorized_at,n.value_json notes_json,e.id execution_id,e.outcome execution_outcome,e.click_count FROM facebook_communities c JOIN facebook_community_human_state s ON s.community_id=c.id AND s.field_name='membership_decision' LEFT JOIN facebook_community_human_state n ON n.community_id=c.id AND n.field_name='notes' LEFT JOIN facebook_community_join_executions e ON e.authorization_action_id=s.source_action_id WHERE s.value_json='"WANT_TO_JOIN"' ORDER BY c.quality_score DESC,c.id`).all().map(row=>({community:this._facebookCommunityRow(row),authorization:{actionId:row.authorization_action_id,authorizedAt:row.authorized_at,url:row.canonical_url,decision:'WANT_TO_JOIN',notes:JSON.parse(row.notes_json||'""')},execution:row.execution_id?{id:row.execution_id,outcome:row.execution_outcome,clickCount:row.click_count}:null}));}
  listFacebookMembershipReconciliationCandidates(){return this.listFacebookCommunityJoinPlan().filter(item=>!item.community.suppressedAt&&item.execution?.clickCount===1).map(item=>({...item,previousState:item.community.membershipState}));}
  recordFacebookMembershipVerification({communityId,joinExecutionId=null,verifierVersion,finalState,reason,evidence={}}={}){const allowed=new Set(['JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','NOT_JOINED','CHALLENGE','AUTH_REQUIRED','VERIFICATION_UNKNOWN']);const next=requiredText(finalState,'finalState').toUpperCase();if(!allowed.has(next))throw new TypeError(`invalid membership verification state: ${next}`);const community=this.getFacebookCommunity(communityId);if(!community)throw new Error(`unknown Facebook community: ${communityId}`);const now=this.now();const verificationId=randomUUID();const corrected=community.membershipState==='JOIN_FAILED'&&next==='JOINED_CONFIRMED';this.db.transaction(()=>{this.db.prepare(`INSERT INTO facebook_community_membership_verifications(id,community_id,join_execution_id,verifier_version,previous_state,final_state,reason,evidence_json,lifecycle_corrected,checked_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(verificationId,communityId,joinExecutionId,requiredText(verifierVersion,'verifierVersion'),community.membershipState,next,String(reason||''),json(evidence,{}),corrected?1:0,now,now);const compatible=['JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','CHALLENGE','AUTH_REQUIRED'].includes(next)?next:'NONE';this.db.prepare('UPDATE facebook_communities SET verification_status=?,join_status=?,last_checked_at=?,updated_at=? WHERE id=?').run(next,compatible,now,now,communityId);if(next==='JOINED_CONFIRMED'){const base=this.db.prepare('SELECT membership_state FROM facebook_communities WHERE id=?').get(communityId);if(base.membership_state!=='JOINED_CONFIRMED')this.transitionFacebookCommunity(communityId,'JOINED_CONFIRMED',{reason:corrected?'membership_verification_correction':'membership_verification_confirmed',actionId:this.db.prepare('SELECT authorization_action_id FROM facebook_community_join_executions WHERE id=?').get(joinExecutionId)?.authorization_action_id||null,evidenceRefs:[verificationId,joinExecutionId].filter(Boolean)});}})();return{verificationId,previousState:community.membershipState,finalState:next,lifecycleCorrected:corrected,community:this.getFacebookCommunity(communityId)};}
  getFacebookMembershipVerifications(communityId=null){const rows=communityId?this.db.prepare('SELECT * FROM facebook_community_membership_verifications WHERE community_id=? ORDER BY checked_at,id').all(communityId):this.db.prepare('SELECT * FROM facebook_community_membership_verifications ORDER BY checked_at,id').all();return rows.map(row=>({id:row.id,communityId:row.community_id,joinExecutionId:row.join_execution_id,verifierVersion:row.verifier_version,previousState:row.previous_state,finalState:row.final_state,reason:row.reason,evidence:JSON.parse(row.evidence_json||'{}'),lifecycleCorrected:Boolean(row.lifecycle_corrected),checkedAt:row.checked_at}));}
  beginFacebookCommunityJoin({communityId,authorizationActionId,authorizedUrl,authorizedAt}={}){const id=requiredText(communityId,'communityId');const actionId=requiredText(authorizationActionId,'authorizationActionId');const community=this.db.prepare('SELECT * FROM facebook_communities WHERE id=?').get(id);if(!community)throw new Error(`unknown Facebook community: ${id}`);if(community.suppressed_at)return{canClick:false,reason:'suppressed',execution:null};if(community.canonical_url!==requiredText(authorizedUrl,'authorizedUrl'))return{canClick:false,reason:'authorized_url_mismatch',execution:null};const existing=this.db.prepare('SELECT * FROM facebook_community_join_executions WHERE authorization_action_id=?').get(actionId);if(existing){this.db.prepare('UPDATE facebook_community_join_executions SET check_count=check_count+1,updated_at=? WHERE id=?').run(this.now(),existing.id);return{canClick:false,reason:'authorization_already_consumed',execution:{id:existing.id,communityId:id,authorizationActionId:actionId,outcome:existing.outcome,clickCount:existing.click_count,checkCount:existing.check_count+1}};}const now=this.now(),executionId=randomUUID();this.db.prepare(`INSERT INTO facebook_community_join_executions(id,community_id,authorization_action_id,authorized_url,authorized_at,status,outcome,click_count,check_count,reason,evidence_json,started_at,finished_at,created_at,updated_at) VALUES(?,?,?,?,?,'RUNNING',NULL,0,1,'','{}',?,NULL,?,?)`).run(executionId,id,actionId,authorizedUrl,iso(authorizedAt,'authorizedAt'),now,now,now);return{canClick:true,reason:'authorized',execution:{id:executionId,communityId:id,authorizationActionId:actionId,clickCount:0,checkCount:1}};}
  recordFacebookCommunityJoinOutcome(executionId,{outcome,clicked=false,reason='',evidence={}}={}){const allowed=new Set(['JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','ALREADY_JOINED','JOIN_FAILED','CHALLENGE','AUTH_REQUIRED','POLICY_BLOCKED','VERIFICATION_UNKNOWN']);const next=requiredText(outcome,'outcome').toUpperCase();if(!allowed.has(next))throw new TypeError(`invalid community join outcome: ${next}`);if(next==='JOIN_FAILED'&&!/^positive_failure_evidence:/i.test(String(reason||'')))throw new TypeError('JOIN_FAILED requires positive failure evidence');const execution=this.db.prepare('SELECT * FROM facebook_community_join_executions WHERE id=?').get(requiredText(executionId,'executionId'));if(!execution)throw new Error(`unknown community join execution: ${executionId}`);if(clicked&&execution.click_count>=1)throw new Error('join authorization was already consumed by a click');const now=this.now();this.db.prepare(`UPDATE facebook_community_join_executions SET status='COMPLETED',outcome=?,click_count=click_count+?,reason=?,evidence_json=?,finished_at=?,updated_at=? WHERE id=?`).run(next,clicked?1:0,String(reason||''),json(evidence,{}),now,now,execution.id);const communityStatus=next==='ALREADY_JOINED'?'JOINED_CONFIRMED':next==='VERIFICATION_UNKNOWN'?'NONE':next;this.db.prepare("UPDATE facebook_communities SET join_status=?,verification_status=CASE WHEN ?='VERIFICATION_UNKNOWN' THEN 'VERIFICATION_UNKNOWN' ELSE verification_status END,last_checked_at=?,updated_at=? WHERE id=?").run(communityStatus,next,now,now,execution.community_id);if(['JOINED_CONFIRMED','ALREADY_JOINED'].includes(next)){const current=this.db.prepare('SELECT membership_state FROM facebook_communities WHERE id=?').get(execution.community_id);if(current.membership_state!=='JOINED_CONFIRMED')this.transitionFacebookCommunity(execution.community_id,'JOINED_CONFIRMED',{reason:`join_${next.toLowerCase()}`,actionId:execution.authorization_action_id,evidenceRefs:[execution.id]});}return this.getFacebookCommunity(execution.community_id);}
  getFacebookCommunityJoinExecutions(){return this.db.prepare('SELECT * FROM facebook_community_join_executions ORDER BY created_at,id').all().map(row=>({id:row.id,communityId:row.community_id,authorizationActionId:row.authorization_action_id,authorizedUrl:row.authorized_url,authorizedAt:row.authorized_at,status:row.status,outcome:row.outcome,clickCount:row.click_count,checkCount:row.check_count,reason:row.reason,evidence:JSON.parse(row.evidence_json),startedAt:row.started_at,finishedAt:row.finished_at}));}
  getFacebookCommunityEvents(id){return this.db.prepare('SELECT * FROM facebook_community_events WHERE community_id=? ORDER BY occurred_at,rowid').all(id).map(r=>({id:r.id,communityId:r.community_id,fromState:r.from_state,toState:r.to_state,reason:r.reason,runId:r.run_id,actionId:r.action_id,evidenceRefs:JSON.parse(r.evidence_refs_json),occurredAt:r.occurred_at}));}
  recordFacebookPost(post){const now=this.now();this.db.prepare(`INSERT INTO facebook_posts(id,post_key,community_id,external_id,canonical_url,author_display_name,posted_at,raw_text,text_hash,links_json,emails_json,image_refs_json,image_evidence_present,opportunity_type,company_name,company_identity_status,authenticity_score,authenticity_band,authenticity_reasons_json,evidence_json,browser_run_id,observation_id,first_seen_at,last_seen_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(post_key) DO UPDATE SET last_seen_at=excluded.last_seen_at,observation_id=COALESCE(facebook_posts.observation_id,excluded.observation_id),updated_at=excluded.updated_at`).run(post.id,post.postKey,post.communityId,post.externalId||null,post.canonicalUrl,post.authorDisplayName||'',post.postedAt,post.rawText,post.textHash,json(post.links,[]),json(post.emails,[]),json(post.imageRefs,[]),post.imageEvidencePresent?1:0,post.opportunityType,post.companyName||'',post.companyIdentityStatus,post.authenticity.score,post.authenticity.band,json(post.authenticity.reasons,[]),json(post.evidence,[]),post.browserRunId,post.observationId||null,now,now,now);return this.db.prepare('SELECT * FROM facebook_posts WHERE post_key=?').get(post.postKey);}
  listFacebookPosts({communityId=null}={}){return this.db.prepare('SELECT * FROM facebook_posts WHERE (? IS NULL OR community_id=?) ORDER BY first_seen_at,id').all(communityId,communityId);}
  getFacebookCheckpoint(id){const r=this.db.prepare('SELECT * FROM facebook_monitor_checkpoints WHERE community_id=?').get(id);return r?{communityId:r.community_id,lastCheckedAt:r.last_checked_at,newestSeenMarker:r.newest_seen_marker,oldestSeenMarker:r.oldest_seen_marker,seenPostIds:JSON.parse(r.seen_post_ids_json),runId:r.run_id}:null;}
  recordFacebookCheckpoint(id,{runId,seenPostIds=[],newestSeenMarker=null,oldestSeenMarker=null}={}){const now=this.now();this.db.prepare(`INSERT INTO facebook_monitor_checkpoints(community_id,last_checked_at,newest_seen_marker,oldest_seen_marker,seen_post_ids_json,run_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(community_id) DO UPDATE SET last_checked_at=excluded.last_checked_at,newest_seen_marker=excluded.newest_seen_marker,oldest_seen_marker=excluded.oldest_seen_marker,seen_post_ids_json=excluded.seen_post_ids_json,run_id=excluded.run_id,updated_at=excluded.updated_at`).run(id,now,newestSeenMarker,oldestSeenMarker,json(seenPostIds,[]),requiredText(runId,'runId'),now);return this.getFacebookCheckpoint(id);}
  recordFacebookCommunityMonitorMetric(metric={}){const classifications=metric.classifications||{};this.db.prepare(`INSERT INTO facebook_community_monitor_metrics(run_id,community_id,outcome,posts_inspected,recent_unique_posts,classifications_json,opportunities_found,authenticity_average,authenticity_passed,acquisition_observations,new_jobs,accepted_candidates,duration_ms,challenges,useful_signal_ratio,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,community_id) DO UPDATE SET outcome=excluded.outcome,posts_inspected=excluded.posts_inspected,recent_unique_posts=excluded.recent_unique_posts,classifications_json=excluded.classifications_json,opportunities_found=excluded.opportunities_found,authenticity_average=excluded.authenticity_average,authenticity_passed=excluded.authenticity_passed,acquisition_observations=excluded.acquisition_observations,new_jobs=excluded.new_jobs,accepted_candidates=excluded.accepted_candidates,duration_ms=excluded.duration_ms,challenges=excluded.challenges,useful_signal_ratio=excluded.useful_signal_ratio,checked_at=excluded.checked_at`).run(requiredText(metric.runId,'runId'),requiredText(metric.communityId,'communityId'),requiredText(metric.outcome,'outcome'),metric.postsInspected||0,metric.recentUniquePosts||0,json(classifications,{}),metric.opportunitiesFound||0,Number(metric.authenticityAverage||0),metric.authenticityPassed||0,metric.acquisitionObservations||0,metric.newJobs||0,metric.acceptedCandidates||0,metric.durationMs||0,metric.challenges||0,Number(metric.usefulSignalRatio||0),metric.checkedAt||this.now());return this.listFacebookCommunityMonitorMetrics(metric.runId).find(x=>x.communityId===metric.communityId);}
  listFacebookCommunityMonitorMetrics(runId=null){const rows=runId?this.db.prepare('SELECT * FROM facebook_community_monitor_metrics WHERE run_id=? ORDER BY community_id').all(runId):this.db.prepare('SELECT * FROM facebook_community_monitor_metrics ORDER BY checked_at DESC,community_id').all();return rows.map(r=>({runId:r.run_id,communityId:r.community_id,outcome:r.outcome,postsInspected:r.posts_inspected,recentUniquePosts:r.recent_unique_posts,classifications:JSON.parse(r.classifications_json),opportunitiesFound:r.opportunities_found,authenticityAverage:r.authenticity_average,authenticityPassed:r.authenticity_passed,acquisitionObservations:r.acquisition_observations,newJobs:r.new_jobs,acceptedCandidates:r.accepted_candidates,durationMs:r.duration_ms,challenges:r.challenges,usefulSignalRatio:r.useful_signal_ratio,checkedAt:r.checked_at}));}

  getOperationalCandidateData() {
    const activeCandidates = this.listActiveCandidates();
    const latestSnapshotRun = this.db.prepare(`SELECT run_id FROM daily_priority_snapshots
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get()?.run_id || null;
    const snapshot = latestSnapshotRun ? this.getDailyPrioritySnapshot(latestSnapshotRun) : [];
    return {
      activeCandidates, latestSnapshotRun, snapshot,
      top10: snapshot.filter(item => item.isTop10),
      metrics: latestSnapshotRun ? this.getSemanticFunnelMetrics(latestSnapshotRun) : [],
      researchNeeds: [
        ...this.listCandidateResearchNeeds({ status: 'OPEN' }),
        ...this.listCandidateResearchNeeds({ status: 'BLOCKED' }),
      ],
      reassessmentQueue: this.listCandidateReassessmentQueue({ status: 'PENDING' }),
    };
  }

  getControlPlaneData({ spreadsheetId = '', candidateScope = 'all', includeAttention = true } = {}) {
    if (!['all', 'active', 'attention', 'decision'].includes(candidateScope)) throw new TypeError('candidateScope must be all, active, attention, or decision');
    const candidateData = this.getOperationalCandidateData();
    const scopedIds = candidateScope === 'active'
      ? new Set(candidateData.activeCandidates.map(item => item.jobId))
      : candidateScope === 'attention' ? new Set(candidateData.top10.map(item => item.jobId))
      : candidateScope === 'decision' ? new Set([
        ...candidateData.activeCandidates.map(item => item.jobId),
        ...this.db.prepare('SELECT DISTINCT job_id FROM application_packages').all().map(row => row.job_id),
        ...this.db.prepare('SELECT DISTINCT job_id FROM application_enrichment_requests').all().map(row => row.job_id),
        ...this.db.prepare("SELECT DISTINCT entity_id FROM human_field_state WHERE entity_type = 'JOB' AND field_name = 'application_status' AND value_json != '\"NOT_STARTED\"'").all().map(row => row.entity_id),
      ]) : null;
    const jobs = this.db.prepare('SELECT * FROM jobs ORDER BY last_seen_at DESC, id').all()
      .filter(job => !scopedIds || scopedIds.has(job.id)).map(job => {
      const observation = this.db.prepare('SELECT * FROM job_observations WHERE job_id = ? ORDER BY last_observed_at DESC, rowid DESC LIMIT 1').get(job.id);
      const assessment = this.getLatestAssessment(job.id);
      const evaluation = this.getLatestJobEvaluation(job.id);
      const applicationPackage = this.getLatestApplicationPackage(job.id);
      let rawMetadata={};try{rawMetadata=JSON.parse(observation?.raw_metadata_json||'{}');}catch{}
      const sourceLabel=rawMetadata.sourceLabel||observation?.provider||'';
      return {
        job: { id: job.id, title: job.canonical_title, company: job.canonical_company, location: job.location || '', description: observation?.description || '', status: job.status, url: job.canonical_url || observation?.canonical_url || observation?.source_url || '', source: sourceLabel, lastSeenAt: job.last_seen_at, identityConfidence: observation?.identity_confidence || '' },
        observation: observation ? { id: observation.id, canonicalUrl: observation.canonical_url || '', sourceUrl: observation.source_url || '', description: observation.description || '', identityMethod: observation.identity_method || '', identityConfidence: observation.identity_confidence || '' } : null,
        assessment: assessment ? { ...assessment, employmentModel: assessment.result?.eligibility?.signals?.employmentModel || assessment.result?.candidateFit?.signals?.employmentModel || '' } : null,
        evaluation, applicationPackage,
      };
    });
    const contactRows = this.db.prepare(`
      SELECT cr.job_id, c.id company_id, c.canonical_name company_name,
        p.id person_id, p.canonical_name person_name, p.role, p.profile_url,
        r.relationship_type, r.confidence, r.evidence_json
      FROM contact_relationships r
      JOIN contact_research cr ON cr.id = r.research_id
      JOIN companies c ON c.id = r.company_id
      JOIN people p ON p.id = r.person_id
      WHERE cr.id = (SELECT newest.id FROM contact_research newest WHERE newest.job_id = cr.job_id ORDER BY newest.contact_research_version DESC LIMIT 1)
      ORDER BY c.canonical_name, p.canonical_name, cr.job_id
    `).all();
    const contacts = contactRows.map(row => ({
      jobId: row.job_id, company: { id: row.company_id, name: row.company_name },
      person: { id: row.person_id, name: row.person_name, role: row.role, profileUrl: row.profile_url, evidence: this.db.prepare('SELECT evidence_json FROM person_evidence WHERE person_id = ? ORDER BY observed_at, evidence_id').all(row.person_id).map(item => JSON.parse(item.evidence_json)) },
      relationship: { type: row.relationship_type, confidence: row.confidence, evidence: JSON.parse(row.evidence_json) },
    }));
    const contactResearch = this.db.prepare(`SELECT cr.* FROM contact_research cr
      WHERE cr.id=(SELECT newest.id FROM contact_research newest WHERE newest.job_id=cr.job_id ORDER BY newest.contact_research_version DESC LIMIT 1)
      ORDER BY cr.researched_at,cr.id`).all().map(row=>{let artifact={};try{artifact=JSON.parse(row.artifact_json||'{}');}catch{}return{id:row.id,jobId:row.job_id,status:row.status,completionStatus:artifact.completionStatus||'NOT_RUN',resultStatus:artifact.resultStatus||'',primaryContact:artifact.primaryContact||null,contacts:artifact.contacts||[],searchReport:artifact.searchReport||null,reviewStatus:row.review_status,researchedAt:row.researched_at,sourceHash:row.source_hash};});
    const followUpFields = this.getHumanFieldState().filter(item => item.entityType === 'FOLLOW_UP');
    const followUpMap = new Map();
    for (const item of followUpFields) { const current = followUpMap.get(item.entityId) || { id: item.entityId }; current[item.field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = item.value; followUpMap.set(item.entityId, current); }
    const latestCommunityMetrics=new Map();for(const metric of this.listFacebookCommunityMonitorMetrics()){if(!latestCommunityMetrics.has(metric.communityId))latestCommunityMetrics.set(metric.communityId,metric);}
    const humanState=this.getHumanFieldState();
    const humanByJob=new Map();for(const item of humanState.filter(item=>item.entityType==='JOB')){const current=humanByJob.get(item.entityId)||{};current[item.field]=item.value;humanByJob.set(item.entityId,current);}
    const enrichmentRequests=this.listEnrichmentRequests(),applicationExecutions=this.listApplicationExecutions();
    const enrichmentByJob=new Map(enrichmentRequests.map(item=>[item.jobId,item])),executionByJob=new Map(applicationExecutions.map(item=>[item.jobId,item]));
    const workflowStatusService=new WorkflowStatusService({registry:this,clock:()=>new Date(this.now())});
    const workflowStatuses=jobs.map(item=>workflowStatusService.resolveJobStatus(item.job.id,{humanDecision:humanByJob.get(item.job.id)?.human_decision||'NO_ACTION',applicationDecision:humanByJob.get(item.job.id)?.application_decision||'NO_ACTION',enrichment:enrichmentByJob.get(item.job.id),execution:executionByJob.get(item.job.id)}));
    const communityWorkflowStatuses=this.listFacebookCommunities().map(item=>workflowStatusService.getCommunityStatus(item.id));
    const workflowCommands=this.listWorkflowCommands({ limit: 100 });
    const commandWorkflowStatuses=workflowCommands.map(item=>workflowStatusService.getCommandStatus(item.commandId));
    const notificationPreferences={enabled:this.notificationOutbox.preferences.enabled,recipient:this.notificationOutbox.preferences.recipient,dailyCompletionSummary:this.notificationOutbox.preferences.dailyCompletionSummary,workflowDigests:this.notificationOutbox.preferences.workflowDigests};
    const lastNotification=this.listNotificationIntents({limit:1})[0]||null;
    const recentNotifications=this.listNotificationIntents({limit:100}),lastDailySummary=recentNotifications.find(item=>item.notificationType==='DAILY_COMPLETION_SUMMARY')||null,lastWorkflowDigest=recentNotifications.find(item=>item.notificationType==='WORKFLOW_DIGEST')||null;
    const data = {
      jobs, contacts, contactResearch, communities: this.listFacebookCommunities().map(item=>({...item,monitoring:latestCommunityMetrics.get(item.id)||null})), humanState: this.getHumanFieldState(), followUps: [...followUpMap.values()],
      enrichmentRequests,
      applicationHumanAnswers: this.listApplicationHumanAnswers(),
      preferenceSignals: this.listPreferenceSignals(),
      candidateSelection: candidateData, applicationExecutions, humanHandoffs:this.listHumanHandoffs(), outreachAuthorizations:this.listOutreachAuthorizations(),outreachExecutions:this.listOutreachExecutions(),
      runs: this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 100').all().map(run => ({ id: run.id, status: run.status, startedAt: run.started_at, finishedAt: run.finished_at })),
      syncState: spreadsheetId ? this.getSheetSyncState(spreadsheetId) : null,
      workflowCommands, workflowStatuses, communityWorkflowStatuses, commandWorkflowStatuses,
      notificationPreferences,lastNotification,lastDailySummary,lastWorkflowDigest,notificationMetrics:this.getNotificationMetrics(),operationalSummary:readOperationalSummary(this.db),
      rejectedHumanActions:this.db.prepare("SELECT tab_name tabName,entity_id entityId,field_name field,status,reason,observed_at observedAt FROM human_actions WHERE status='REJECTED' ORDER BY observed_at DESC,rowid DESC LIMIT 100").all(),
      recentWorkflowEvents:this.timeline.getRecent(1000),
    };
    if(includeAttention){data.attentionItems=deriveHumanAttentionItems(data,{now:this.clock()});const byType={};for(const value of data.attentionItems)byType[value.attentionType]=(byType[value.attentionType]||0)+1;data.attentionCounts={total:data.attentionItems.length,byType,clear:data.attentionItems.length===0};}
    return data;
  }

  updateApplicationPackageStatus(packageId, status, { reviewedAt = this.now() } = {}) {
    const id = requiredText(packageId, 'packageId');
    const next = requiredText(status, 'status').toUpperCase();
    if (!['DRAFT', 'REVIEW_REQUIRED', 'APPROVED', 'ARCHIVED'].includes(next)) throw new TypeError('invalid application package status');
    const current = this.db.prepare('SELECT * FROM application_packages WHERE id = ?').get(id);
    if (!current) throw new Error(`unknown application package: ${id}`);
    if (current.status === next) return this._applicationPackageRow(current);
    const allowed = {
      DRAFT: new Set(['REVIEW_REQUIRED', 'APPROVED', 'ARCHIVED']),
      REVIEW_REQUIRED: new Set(['DRAFT', 'APPROVED', 'ARCHIVED']),
      APPROVED: new Set(['ARCHIVED']), ARCHIVED: new Set(),
    };
    if (!allowed[current.status].has(next)) throw new Error(`application package cannot transition from ${current.status} to ${next}`);
    if (next === 'APPROVED' && current.validation_status !== 'VALID') throw new Error('a rejected package cannot be approved');
    if (next === 'DRAFT' && current.validation_status !== 'VALID') throw new Error('a rejected package cannot become a draft without regeneration');
    const at = iso(reviewedAt, 'reviewedAt');
    this.db.prepare('UPDATE application_packages SET status = ?, reviewed_at = ?, updated_at = ? WHERE id = ?').run(next, at, this.now(), id);
    return this._applicationPackageRow(this.db.prepare('SELECT * FROM application_packages WHERE id = ?').get(id));
  }

  listApplicationPackageCandidates({ jobId = null, limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 100));
    return this.db.prepare(`
      SELECT e.* FROM job_evaluations e
      WHERE e.status = 'VALID' AND e.recommendation = 'APPLY'
        AND e.id = (SELECT newest.id FROM job_evaluations newest WHERE newest.job_id = e.job_id AND newest.status = 'VALID' ORDER BY newest.evaluated_at DESC, newest.rowid DESC LIMIT 1)
        AND (? IS NULL OR e.job_id = ?)
      ORDER BY e.overall_fit DESC, e.evaluated_at, e.id
      LIMIT ?
    `).all(jobId, jobId, boundedLimit).map(row => this._jobEvaluationRow(row));
  }

  listDeepEvaluationCandidates({ jobId = null, limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 100));
    return this.db.prepare(`
      SELECT a.id AS assessment_id, a.job_id, a.observation_id, a.result_json,
        o.title, o.company, o.location, o.description, o.source_url, o.canonical_url, o.raw_metadata_json
      FROM job_assessments a
      JOIN job_observations o ON o.id = a.observation_id
      WHERE a.decision = 'SHORTLIST'
        AND a.id = (SELECT newest.id FROM job_assessments newest WHERE newest.job_id = a.job_id ORDER BY newest.assessed_at DESC, newest.rowid DESC LIMIT 1)
        AND (? IS NULL OR a.job_id = ?)
      ORDER BY a.final_priority_score DESC, a.assessed_at, a.id
      LIMIT ?
    `).all(jobId, jobId, boundedLimit).map(row => ({
      job: {
        id: row.job_id, jobId: row.job_id, observationId: row.observation_id,
        title: row.title, company: row.company, location: row.location || '', description: row.description || '',
        sourceUrl: row.source_url, canonicalUrl: row.canonical_url,
        rawMetadata: JSON.parse(row.raw_metadata_json || '{}'),
      },
      assessment: { ...JSON.parse(row.result_json), id: row.assessment_id, jobId: row.job_id, observationId: row.observation_id, decision: 'SHORTLIST' },
    }));
  }

  listAssessmentCandidates({ eligibilityRulesVersion, rankingRulesVersion, profileHash, runId = null, jobId = null, limit = 100 } = {}) {
    const boundedLimit = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 100));
    const eligibilityVersion = requiredText(eligibilityRulesVersion, 'eligibilityRulesVersion');
    const rankingVersion = requiredText(rankingRulesVersion, 'rankingRulesVersion');
    const policyHash = requiredText(profileHash, 'profileHash');
    const rows = this.db.prepare(`
      SELECT o.*, j.canonical_title, j.canonical_company
      FROM job_observations o
      JOIN jobs j ON j.id = o.job_id
      WHERE o.id = (
        SELECT newest.id FROM job_observations newest
        WHERE newest.job_id = o.job_id
        ORDER BY newest.first_observed_at DESC, newest.id DESC LIMIT 1
      )
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM run_observations ro WHERE ro.run_id = ? AND ro.observation_id = o.id
        ))
        AND (? IS NULL OR o.job_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM job_assessments a
          WHERE a.observation_id = o.id
            AND a.eligibility_rules_version = ?
            AND a.ranking_rules_version = ?
            AND a.profile_hash = ?
        )
      ORDER BY o.first_observed_at, o.id
      LIMIT ?
    `).all(runId, runId, jobId, jobId, eligibilityVersion, rankingVersion, policyHash, boundedLimit);
    return rows.map(row => {
      let rawMetadata = {};
      try { rawMetadata = JSON.parse(row.raw_metadata_json || '{}'); } catch { /* malformed legacy metadata has no assessment signal */ }
      return {
        jobId: row.job_id,
        observationId: row.id,
        title: row.title,
        company: row.company,
        location: row.location || '',
        description: row.description || '',
        salary: rawMetadata.salary || null,
        rawMetadata,
        sourceUrl: row.source_url,
        canonicalUrl: row.canonical_url,
      };
    });
  }

  listCandidateSelectionInputs({ runId = null, jobId = null } = {}) {
    const human = new Map();
    for (const item of this.getHumanFieldState().filter(item => item.entityType === 'JOB')) {
      const state = human.get(item.entityId) || {};
      state[item.field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = item.value;
      human.set(item.entityId, state);
    }
    return this.db.prepare(`
      SELECT o.*, j.canonical_title, j.canonical_company, j.status AS job_status,
        CASE WHEN ? IS NOT NULL AND EXISTS (
          SELECT 1 FROM run_observations ro WHERE ro.run_id = ? AND ro.observation_id = o.id
        ) THEN 1 ELSE 0 END AS observed_in_run
      FROM job_observations o
      JOIN jobs j ON j.id = o.job_id
      WHERE o.id = (
        SELECT newest.id FROM job_observations newest
        WHERE newest.job_id = o.job_id
        ORDER BY newest.last_observed_at DESC, newest.rowid DESC LIMIT 1
      )
        AND (? IS NULL OR o.job_id = ?)
      ORDER BY o.job_id
    `).all(runId, runId, jobId, jobId).map(row => {
      let rawMetadata = {};
      try { rawMetadata = JSON.parse(row.raw_metadata_json || '{}'); } catch { /* legacy metadata is optional */ }
      const fieldEvidence = this.db.prepare(`SELECT field_name, value_json, confidence, extraction_method, provider, source_url
        FROM job_field_evidence WHERE observation_id = ? ORDER BY id`).all(row.id).map(item => {
        let value = null; try { value = JSON.parse(item.value_json); } catch { value = item.value_json; }
        return { field: item.field_name, value, confidence: item.confidence, extractionMethod: item.extraction_method,
          provider: item.provider, sourceUrl: item.source_url };
      });
      return {
        jobId: row.job_id, observationId: row.id,
        title: row.title || row.canonical_title, company: row.company || row.canonical_company,
        location: row.location || '', description: row.description || '',
        provider: row.provider, sourceUrl: row.source_url || '', canonicalUrl: row.canonical_url || '',
        postedAt: row.posted_at, firstObservedAt: row.first_observed_at, lastObservedAt: row.last_observed_at,
        observedInRun: Boolean(row.observed_in_run), rawMetadata, fieldEvidence,
        provenance: { provider: row.provider, sourceUrl: row.source_url || '', extractionMethod: row.extraction_method, confidence: row.confidence },
        humanState: human.get(row.job_id) || {},
        jobStatus: row.job_status,
      };
    });
  }

  _activeCandidateRow(row) {
    if (!row) return null;
    return {
      jobId: row.job_id, observationId: row.observation_id, selectionRunId: row.selection_run_id,
      state: row.state, enteredAt: row.entered_at, lastReviewedAt: row.last_reviewed_at,
      stateReason: row.state_reason, preliminaryScore: row.preliminary_score,
      freshnessDays: row.freshness_days, source: row.source, sourceKey: row.source_key,
      previousRank: row.previous_rank, selectionRank: row.selection_rank,
      rulesVersion: row.rules_version, policyHash: row.policy_hash, updatedAt: row.updated_at,
    };
  }

  listActiveCandidates({ includeTerminal = false } = {}) {
    const where = includeTerminal ? '' : "WHERE state IN ('ACTIVE', 'CARRYOVER')";
    return this.db.prepare(`SELECT * FROM active_candidates ${where} ORDER BY selection_rank, job_id`)
      .all().map(row => this._activeCandidateRow(row));
  }

  recordCandidateSelection(runId, result, { decidedAt = this.now() } = {}) {
    const run = this.getRun(requiredText(runId, 'selection run id'));
    if (!run) throw new Error(`unknown run: ${runId}`);
    const at = iso(decidedAt, 'decidedAt');
    const rulesVersion = requiredText(result?.rulesVersion, 'candidate rulesVersion');
    const policyHash = requiredText(result?.policyHash, 'candidate policyHash');
    const decisions = Array.isArray(result?.decisions) ? result.decisions : [];
    const active = Array.isArray(result?.activeCandidates) ? result.activeCandidates : [];
    const transitions = Array.isArray(result?.transitions) ? result.transitions : [];
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO candidate_selection_runs(
        run_id, rules_version, policy_hash, capacity, threshold, fill_to_capacity,
        raw_count, pass_count, reject_count, unknown_count, active_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        rules_version = excluded.rules_version, policy_hash = excluded.policy_hash,
        capacity = excluded.capacity, threshold = excluded.threshold,
        raw_count = excluded.raw_count, pass_count = excluded.pass_count,
        reject_count = excluded.reject_count, unknown_count = excluded.unknown_count,
        active_count = excluded.active_count, updated_at = excluded.updated_at`)
        .run(runId, rulesVersion, policyHash, result.capacity, result.threshold,
          result.counts?.raw || 0, result.counts?.PASS || 0, result.counts?.REJECT || 0,
          result.counts?.UNKNOWN || 0, result.counts?.active || 0, at, at);
      const writeDecision = this.db.prepare(`INSERT INTO candidate_filter_decisions(
        id, decision_key, run_id, job_id, observation_id, outcome, preliminary_score,
        freshness_days, source, source_key, pool_only, evidence_weak, reasons_json,
        evidence_refs_json, rules_version, policy_hash, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, job_id) DO UPDATE SET
        observation_id = excluded.observation_id, outcome = excluded.outcome,
        preliminary_score = excluded.preliminary_score, freshness_days = excluded.freshness_days,
        source = excluded.source, source_key = excluded.source_key,
        pool_only = excluded.pool_only, evidence_weak = excluded.evidence_weak,
        reasons_json = excluded.reasons_json, evidence_refs_json = excluded.evidence_refs_json,
        rules_version = excluded.rules_version, policy_hash = excluded.policy_hash,
        decided_at = excluded.decided_at`);
      for (const item of decisions) {
        if (!VALID_FILTER_OUTCOMES.has(item.outcome)) throw new TypeError(`invalid filter outcome: ${item.outcome}`);
        const decisionKey = hashStable(`${runId}:${item.jobId}:${rulesVersion}:${policyHash}`);
        writeDecision.run(randomUUID(), decisionKey, runId, item.jobId, item.observationId, item.outcome,
          item.preliminaryScore, item.freshnessDays, item.source || '', item.sourceKey || '',
          item.poolOnly ? 1 : 0, item.evidenceWeak ? 1 : 0, json(item.reasons, []),
          json(item.evidenceRefs, []), rulesVersion, policyHash, at);
      }
      const writeCandidate = this.db.prepare(`INSERT INTO active_candidates(
        job_id, observation_id, selection_run_id, state, entered_at, last_reviewed_at,
        state_reason, preliminary_score, freshness_days, source, source_key, previous_rank,
        selection_rank, rules_version, policy_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        observation_id = excluded.observation_id, selection_run_id = excluded.selection_run_id,
        state = excluded.state, last_reviewed_at = excluded.last_reviewed_at,
        state_reason = excluded.state_reason, preliminary_score = excluded.preliminary_score,
        freshness_days = excluded.freshness_days, source = excluded.source,
        source_key = excluded.source_key, previous_rank = excluded.previous_rank,
        selection_rank = excluded.selection_rank, rules_version = excluded.rules_version,
        policy_hash = excluded.policy_hash, updated_at = excluded.updated_at`);
      const transitionItems = [...active, ...transitions];
      for (const item of transitionItems) {
        if (!VALID_CANDIDATE_STATES.has(item.state)) throw new TypeError(`invalid candidate state: ${item.state}`);
        const before = this.db.prepare('SELECT state FROM active_candidates WHERE job_id = ?').get(item.jobId);
        writeCandidate.run(item.jobId, item.observationId, runId, item.state, at, at,
          requiredText(item.stateReason, 'candidate stateReason'), item.preliminaryScore,
          item.freshnessDays, item.source || '', item.sourceKey || '', item.previousRank,
          item.selectionRank || null, rulesVersion, policyHash, at);
        if (before?.state !== item.state) {
          const transitionKey = hashStable(`${runId}:${item.jobId}:${before?.state || ''}:${item.state}:${item.stateReason}`);
          this.db.prepare(`INSERT OR IGNORE INTO active_candidate_transitions(
            id, transition_key, run_id, job_id, observation_id, from_state, to_state, reason, changed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), transitionKey, runId, item.jobId, item.observationId,
              before?.state || null, item.state, item.stateReason, at);
        }
      }
    })();
    return this.getCandidateSelectionRun(runId);
  }

  _candidateResearchNeedRow(row) {
    if (!row) return null;
    return {
      id: row.id, needKey: row.need_key, selectionRunId: row.selection_run_id,
      assessmentId: row.assessment_id, jobId: row.job_id, observationId: row.observation_id,
      type: row.need_type, dimension: row.dimension, priority: row.priority,
      priorityScore: row.priority_score, status: row.status, reason: row.reason,
      resolutionEvidence: JSON.parse(row.resolution_evidence_json || '[]'),
      unifiedPolicyVersion: row.unified_policy_version,
      eligibilityRulesVersion: row.eligibility_rules_version,
      completenessVersion: row.completeness_version,
      researchNeedsVersion: row.research_needs_version,
      policyHash: row.policy_hash, createdAt: row.created_at, updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
    };
  }

  syncCandidateResearchNeeds({ selectionRunId = null, assessmentId, jobId, observationId, needs = [], versions = {}, policyHash } = {}) {
    const candidateJobId = requiredText(jobId, 'research need jobId');
    const candidateObservationId = requiredText(observationId, 'research need observationId');
    const hash = requiredText(policyHash, 'research need policyHash');
    const at = this.now();
    return this.db.transaction(() => {
      const currentKeys = new Set();
      for (const need of needs) {
        const type = requiredText(need.type, 'research need type').toUpperCase();
        if (!VALID_RESEARCH_NEED_TYPES.has(type)) throw new TypeError(`invalid research need type: ${type}`);
        const key = hashStable(JSON.stringify({ candidateJobId, candidateObservationId, type, version: versions.researchNeedsVersion, policyHash: hash }));
        currentKeys.add(key);
        const existingNeed=this.db.prepare('SELECT id FROM candidate_research_needs WHERE need_key=?').get(key); const needId=existingNeed?.id||randomUUID();
        this.db.prepare(`INSERT INTO candidate_research_needs(
          id, need_key, selection_run_id, assessment_id, job_id, observation_id, need_type,
          dimension, priority, priority_score, status, reason, resolution_evidence_json,
          unified_policy_version, eligibility_rules_version, completeness_version,
          research_needs_version, policy_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, '[]', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(need_key) DO UPDATE SET
          selection_run_id = excluded.selection_run_id, assessment_id = excluded.assessment_id,
          priority = excluded.priority, priority_score = excluded.priority_score,
          reason = excluded.reason, updated_at = excluded.updated_at`)
          .run(needId, key, selectionRunId, assessmentId || null, candidateJobId, candidateObservationId,
            type, requiredText(need.dimension, 'research need dimension'), requiredText(need.priority, 'research need priority'),
            Number(need.priorityScore) || 0, requiredText(need.reason, 'research need reason'),
            requiredText(versions.unifiedPolicyVersion, 'unifiedPolicyVersion'),
            requiredText(versions.eligibilityRulesVersion, 'eligibilityRulesVersion'),
            requiredText(versions.completenessVersion, 'completenessVersion'),
            requiredText(versions.researchNeedsVersion, 'researchNeedsVersion'), hash, at, at);
        if(!existingNeed)this.recordWorkflowEvent({eventType:'RESEARCH_NEED_CREATED',aggregateType:'RESEARCH',aggregateId:needId,correlationId:selectionRunId||this._eventCorrelationForJob(candidateJobId,`research:${needId}`),causationId:assessmentId||selectionRunId||needId,occurredAt:at,source:'daily_core',actorType:'SYSTEM',payload:{type,dimension:need.dimension,priority:need.priority},metadata:{refs:{jobId:candidateJobId,researchNeedId:needId,selectionRunId}},dedupeKey:`research:${needId}:created`});
      }
      const open = this.db.prepare(`SELECT id, need_key FROM candidate_research_needs
        WHERE job_id = ? AND observation_id = ? AND status = 'OPEN'`).all(candidateJobId, candidateObservationId);
      const obsolete = this.db.prepare(`UPDATE candidate_research_needs SET status = 'OBSOLETE', updated_at = ? WHERE id = ?`);
      for (const row of open) if (!currentKeys.has(row.need_key)) obsolete.run(at, row.id);
      return this.listCandidateResearchNeeds({ jobId: candidateJobId, observationId: candidateObservationId });
    })();
  }

  listCandidateResearchNeeds({ status = null, jobId = null, observationId = null, limit = 1000 } = {}) {
    const state = status == null ? null : requiredText(status, 'research need status').toUpperCase();
    if (state && !VALID_RESEARCH_NEED_STATES.has(state)) throw new TypeError(`invalid research need status: ${state}`);
    const bounded = Math.max(1, Math.min(10_000, Number.parseInt(limit, 10) || 1000));
    return this.db.prepare(`SELECT * FROM candidate_research_needs
      WHERE (? IS NULL OR status = ?) AND (? IS NULL OR job_id = ?) AND (? IS NULL OR observation_id = ?)
      ORDER BY priority_score DESC, created_at, need_type LIMIT ?`)
      .all(state, state, jobId, jobId, observationId, observationId, bounded).map(row => this._candidateResearchNeedRow(row));
  }

  reconcileCandidateResearchNeeds({ activeOnly = true, reconciledAt = this.now() } = {}) {
    const at = iso(reconciledAt, 'reconciledAt');
    const scope = activeOnly ? "AND ac.state IN ('ACTIVE', 'CARRYOVER')" : '';
    const stale = this.db.prepare(`
      SELECT rn.id
      FROM candidate_research_needs rn
      JOIN active_candidates ac ON ac.job_id = rn.job_id
      WHERE rn.status IN ('OPEN', 'BLOCKED') ${scope}
        AND rn.assessment_id != (
          SELECT latest.id FROM job_assessments latest
          WHERE latest.job_id = rn.job_id
          ORDER BY latest.assessed_at DESC, latest.rowid DESC LIMIT 1
        )
      ORDER BY rn.created_at, rn.id
    `).all();
    const update = this.db.prepare("UPDATE candidate_research_needs SET status='OBSOLETE', updated_at=? WHERE id=? AND status IN ('OPEN','BLOCKED')");
    const reconciled = this.db.transaction(() => stale.reduce((count, row) => count + update.run(at, row.id).changes, 0))();
    return { considered: stale.length, reconciled, activeOnly, reconciledAt: at };
  }

  resolveCandidateResearchNeed(id, { evidence: resolutionEvidence = [], resolvedAt = this.now() } = {}) {
    const needId = requiredText(id, 'research need id');
    const row = this.db.prepare('SELECT * FROM candidate_research_needs WHERE id = ?').get(needId);
    if (!row) throw new Error(`unknown candidate research need: ${needId}`);
    if (row.status === 'RESOLVED') return { ...this._candidateResearchNeedRow(row), existing: true };
    if (row.status !== 'OPEN' && row.status !== 'BLOCKED') throw new Error(`research need cannot transition from ${row.status} to RESOLVED`);
    const at = iso(resolvedAt, 'resolvedAt');
    return this.db.transaction(() => {
      this.db.prepare(`UPDATE candidate_research_needs SET status = 'RESOLVED', resolution_evidence_json = ?, resolved_at = ?, updated_at = ? WHERE id = ?`)
        .run(json(resolutionEvidence, []), at, at, needId);
      const created=this.db.prepare("SELECT event_id,correlation_id FROM workflow_events WHERE dedupe_key=?").get(`research:${needId}:created`);this.recordWorkflowEvent({eventType:'RESEARCH_NEED_RESOLVED',aggregateType:'RESEARCH',aggregateId:needId,correlationId:created?.correlation_id||this._eventCorrelationForJob(row.job_id,`research:${needId}`),causationId:created?.event_id||needId,occurredAt:at,source:'daily_core',actorType:'SYSTEM',payload:{status:'RESOLVED',evidenceRefCount:resolutionEvidence.length},metadata:{refs:{jobId:row.job_id,researchNeedId:needId}},dedupeKey:`research:${needId}:resolved`});
      const triggerKey = hashStable(`EVIDENCE_RESOLVED:${needId}:${at}:${json(resolutionEvidence, [])}`);
      this.db.prepare(`INSERT OR IGNORE INTO candidate_reassessment_queue(
        id, trigger_key, research_need_id, job_id, observation_id, trigger_type, status,
        evidence_json, policy_hash, triggered_at
      ) VALUES (?, ?, ?, ?, ?, 'EVIDENCE_RESOLVED', 'PENDING', ?, ?, ?)`)
        .run(randomUUID(), triggerKey, needId, row.job_id, row.observation_id, json(resolutionEvidence, []), row.policy_hash, at);
      return this._candidateResearchNeedRow(this.db.prepare('SELECT * FROM candidate_research_needs WHERE id = ?').get(needId));
    })();
  }

  blockCandidateResearchNeed(id, { reason, evidence = [], blockedAt = this.now() } = {}) {
    const needId = requiredText(id, 'research need id'); const at = iso(blockedAt, 'blockedAt');
    const row = this.db.prepare('SELECT * FROM candidate_research_needs WHERE id = ?').get(needId);
    if (!row) throw new Error(`unknown candidate research need: ${needId}`);
    if (!['OPEN', 'BLOCKED'].includes(row.status)) return { ...this._candidateResearchNeedRow(this.db.prepare('SELECT * FROM candidate_research_needs WHERE id = ?').get(needId)), existing: true };
    this.db.prepare(`UPDATE candidate_research_needs SET status='BLOCKED', reason=?, resolution_evidence_json=?, updated_at=? WHERE id=?`)
      .run(requiredText(reason, 'blocked reason'), json(evidence, []), at, needId);
    const created=this.db.prepare("SELECT event_id,correlation_id FROM workflow_events WHERE dedupe_key=?").get(`research:${needId}:created`);this.recordWorkflowEvent({eventType:'RESEARCH_NEED_BLOCKED',aggregateType:'RESEARCH',aggregateId:needId,correlationId:created?.correlation_id||this._eventCorrelationForJob(row.job_id,`research:${needId}`),causationId:created?.event_id||needId,occurredAt:at,source:'daily_core',actorType:'SYSTEM',payload:{status:'BLOCKED',reasonCode:reason},metadata:{refs:{jobId:row.job_id,researchNeedId:needId}},dedupeKey:`research:${needId}:blocked`});
    return this._candidateResearchNeedRow(this.db.prepare('SELECT * FROM candidate_research_needs WHERE id = ?').get(needId));
  }

  listCandidateReassessmentQueue({ status = 'PENDING', jobId = null, limit = 100 } = {}) {
    const state = requiredText(status, 'reassessment status').toUpperCase();
    if (!['PENDING', 'PROCESSED'].includes(state)) throw new TypeError(`invalid reassessment status: ${state}`);
    const bounded = Math.max(1, Math.min(1000, Number.parseInt(limit, 10) || 100));
    return this.db.prepare(`SELECT * FROM candidate_reassessment_queue
      WHERE status = ? AND (? IS NULL OR job_id = ?) ORDER BY triggered_at, id LIMIT ?`)
      .all(state, jobId, jobId, bounded).map(row => ({
        id: row.id, triggerKey: row.trigger_key, researchNeedId: row.research_need_id,
        jobId: row.job_id, observationId: row.observation_id, triggerType: row.trigger_type,
        status: row.status, evidence: JSON.parse(row.evidence_json || '[]'), policyHash: row.policy_hash,
        triggeredAt: row.triggered_at, processedAt: row.processed_at,
      }));
  }

  markCandidateReassessmentProcessed(id, { processedAt = this.now() } = {}) {
    const at = iso(processedAt, 'processedAt');
    const result = this.db.prepare(`UPDATE candidate_reassessment_queue SET status = 'PROCESSED', processed_at = ? WHERE id = ? AND status = 'PENDING'`)
      .run(at, requiredText(id, 'reassessment id'));
    if (!result.changes) throw new Error(`pending reassessment not found: ${id}`);
    return this.listCandidateReassessmentQueue({ status: 'PROCESSED', limit: 1000 }).find(item => item.id === id);
  }

  getCandidateSelectionRun(runId) {
    const row = this.db.prepare('SELECT * FROM candidate_selection_runs WHERE run_id = ?').get(requiredText(runId, 'runId'));
    if (!row) return null;
    return {
      runId: row.run_id, rulesVersion: row.rules_version, policyHash: row.policy_hash,
      capacity: row.capacity, threshold: row.threshold, fillToCapacity: Boolean(row.fill_to_capacity),
      counts: { raw: row.raw_count, PASS: row.pass_count, REJECT: row.reject_count, UNKNOWN: row.unknown_count, active: row.active_count },
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  getLatestAssessmentsForJobs(jobIds) {
    return [...new Set(jobIds)].map(jobId => this.getLatestAssessment(jobId)).filter(Boolean);
  }

  getPreviousPriorityRanks(runId, jobIds) {
    const ranks = new Map();
    const query = this.db.prepare(`SELECT rank FROM daily_priority_snapshots
      WHERE job_id = ? AND run_id != ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
    for (const jobId of jobIds) {
      const row = query.get(jobId, runId);
      if (row) ranks.set(jobId, row.rank);
    }
    return ranks;
  }

  recordDailyPrioritySnapshot(runId, snapshot, { createdAt = this.now() } = {}) {
    if (!this.getRun(requiredText(runId, 'snapshot run id'))) throw new Error(`unknown run: ${runId}`);
    const at = iso(createdAt, 'createdAt');
    const topIds = new Set((snapshot?.top10 || []).map(item => item.jobId));
    const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM daily_priority_snapshots WHERE run_id = ?').run(runId);
      const insert = this.db.prepare(`INSERT INTO daily_priority_snapshots(
        run_id, snapshot_date, job_id, observation_id, rank, previous_rank, movement,
        final_priority_score, eligibility_status, candidate_fit_score, opportunity_score,
        decision, reasons_json, confidence, pool_only, evidence_weak, is_top_10, created_at,
        evidence_completeness_json, research_needs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of entries) insert.run(runId, item.snapshotDate, item.jobId, item.observationId,
        item.rank, item.previousRank, item.movement, item.finalPriorityScore, item.eligibilityStatus,
        item.candidateFitScore, item.opportunityScore, item.decision, json(item.reasons, []),
        item.confidence, item.poolOnly ? 1 : 0, item.evidenceWeak ? 1 : 0,
        topIds.has(item.jobId) ? 1 : 0, at, json(item.evidenceCompleteness), json(item.researchNeeds, []));
    })();
    return this.getDailyPrioritySnapshot(runId);
  }

  getDailyPrioritySnapshot(runId) {
    return this.db.prepare(`SELECT * FROM daily_priority_snapshots WHERE run_id = ? ORDER BY rank`)
      .all(requiredText(runId, 'runId')).map(row => ({
        runId: row.run_id, snapshotDate: row.snapshot_date, jobId: row.job_id,
        observationId: row.observation_id, rank: row.rank, previousRank: row.previous_rank,
        movement: row.movement, finalPriorityScore: row.final_priority_score,
        eligibilityStatus: row.eligibility_status, candidateFitScore: row.candidate_fit_score,
        opportunityScore: row.opportunity_score, decision: row.decision,
        reasons: JSON.parse(row.reasons_json), confidence: row.confidence,
        poolOnly: Boolean(row.pool_only), evidenceWeak: Boolean(row.evidence_weak),
        evidenceCompleteness: JSON.parse(row.evidence_completeness_json || '{}'),
        researchNeeds: JSON.parse(row.research_needs_json || '[]'),
        isTop10: Boolean(row.is_top_10), createdAt: row.created_at,
      }));
  }

  recordSemanticFunnelMetrics(runId, metrics, { scope = 'candidate_selection', recordedAt = this.now() } = {}) {
    if (!this.getRun(requiredText(runId, 'metrics run id'))) throw new Error(`unknown run: ${runId}`);
    const at = iso(recordedAt, 'recordedAt');
    const entries = Object.entries(metrics || {});
    this.db.transaction(() => {
      const write = this.db.prepare(`INSERT INTO semantic_funnel_metrics(run_id, scope, stage, count, recorded_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, scope, stage) DO UPDATE SET count = excluded.count, recorded_at = excluded.recorded_at`);
      for (const [stage, value] of entries) {
        if (!VALID_SEMANTIC_STAGES.has(stage)) throw new TypeError(`invalid semantic funnel stage: ${stage}`);
        const count = Number(value);
        if (!Number.isInteger(count) || count < 0) throw new TypeError(`invalid metric count for ${stage}`);
        write.run(runId, requiredText(scope, 'metrics scope'), stage, count, at);
      }
    })();
    return this.getSemanticFunnelMetrics(runId, scope);
  }

  getSemanticFunnelMetrics(runId, scope = 'candidate_selection') {
    return this.db.prepare(`SELECT stage, count, recorded_at AS recordedAt FROM semantic_funnel_metrics
      WHERE run_id = ? AND scope = ? ORDER BY rowid`).all(requiredText(runId, 'runId'), requiredText(scope, 'scope'));
  }

  setJobStatus(jobId, status, updatedAt = this.now()) {
    const next = requiredText(status, 'job status').toUpperCase();
    const at = iso(updatedAt, 'updatedAt');
    const result = this.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(next, at, jobId);
    if (result.changes !== 1) throw new Error(`unknown job: ${jobId}`);
    return this.getJob(jobId);
  }

  resolveIdentity(input) {
    const provider = normalizeProviderId(input.provider);
    const externalId = String(input.externalId || inferExternalJobId(provider, input.canonicalUrl || input.sourceUrl)).trim();
    const canonicalUrl = canonicalizeJobUrl(input.canonicalUrl || input.sourceUrl);
    const sourceUrl = canonicalizeJobUrl(input.sourceUrl);
    const evidence = { provider, externalId, canonicalUrl, sourceUrl, candidates: [] };

    if (externalId) {
      const match = this.findByExternalId(provider, externalId);
      if (match) return { job: match, method: 'provider_external_id', confidence: 'high', evidence };
    }
    for (const [method, url] of [['canonical_url', canonicalUrl], ['source_url', sourceUrl]]) {
      if (!url) continue;
      const match = this.findByCanonicalUrl(url);
      if (match) return { job: match, method, confidence: 'high', evidence };
    }

    const title = normalizeJobTitle(input.title);
    const company = normalizeJobCompany(input.company);
    const location = normalizeJobLocation(input.location);
    const contentHash = input.contentHash || hashContent(input.description);
    if (title && company && location && contentHash) {
      evidence.candidates = this.db.prepare(`
        SELECT DISTINCT j.id FROM jobs j
        JOIN job_observations o ON o.job_id = j.id
        WHERE j.normalized_title = ? AND j.normalized_company = ?
          AND j.normalized_location = ? AND o.content_hash = ?
      `).all(title, company, location, contentHash).map(row => row.id);
    }
    return {
      job: null,
      method: evidence.candidates.length ? 'new_ambiguous_candidates' : 'new_no_strong_identity',
      confidence: evidence.candidates.length ? 'low' : 'high',
      evidence,
    };
  }

  recordObservation(runId, observation) {
    return this._recordOne(requiredText(runId, 'runId'), observation);
  }

  recordObservations(runId, observations) {
    if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
    return this._recordMany(requiredText(runId, 'runId'), observations);
  }

  _recordObservation(runId, input) {
    const run = this.getRun(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    const provider = requiredText(input.provider, 'provider').toLowerCase();
    const retrievedAt = iso(input.retrievedAt || this.now(), 'retrievedAt');
    const sourceUrl = canonicalizeJobUrl(input.sourceUrl);
    const canonicalUrl = canonicalizeJobUrl(input.canonicalUrl || input.sourceUrl);
    const externalId = String(input.externalId || inferExternalJobId(provider, canonicalUrl || sourceUrl)).trim();
    const title = requiredText(input.title, 'title');
    const company = requiredText(input.company, 'company');
    const location = String(input.location ?? '').trim();
    const contentHash = String(input.contentHash || hashContent(input.description)).trim();
    const confidence = VALID_CONFIDENCE.has(input.confidence) ? input.confidence : 'high';
    const extractionMethod = VALID_EXTRACTION.has(input.extractionMethod) ? input.extractionMethod : 'direct';
    const normalized = {
      ...input, provider, externalId, sourceUrl, canonicalUrl, title, company, location, contentHash,
    };
    const resolution = this.resolveIdentity(normalized);
    const isNewJob = !resolution.job;
    const jobId = resolution.job?.id || randomUUID();

    if (isNewJob) {
      this.db.prepare(`
        INSERT INTO jobs(
          id, canonical_title, canonical_company, canonical_url, location,
          normalized_title, normalized_company, normalized_location,
          first_seen_at, last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId,
        title,
        company,
        canonicalUrl || null,
        location || null,
        normalizeJobTitle(title), normalizeJobCompany(company), normalizeJobLocation(location),
        retrievedAt, retrievedAt, retrievedAt, retrievedAt,
      );
    }

    const snapshotHash = observationSnapshotHash(normalized);
    const identitySeed = externalId || canonicalUrl || sourceUrl || `${normalizeJobCompany(company)}|${normalizeJobTitle(title)}|${normalizeJobLocation(location)}`;
    const observationKey = hashStable(`${provider}|${identitySeed}|${snapshotHash}`);
    const duplicate = this.db.prepare('SELECT * FROM job_observations WHERE observation_key = ?').get(observationKey);
    if (duplicate) {
      this.db.prepare('UPDATE job_observations SET last_observed_at = ?, seen_count = seen_count + 1 WHERE id = ?')
        .run(retrievedAt, duplicate.id);
      this.db.prepare('UPDATE jobs SET last_seen_at = ?, updated_at = ? WHERE id = ?')
        .run(retrievedAt, retrievedAt, duplicate.job_id);
      this.db.prepare(`
        INSERT OR IGNORE INTO run_observations(run_id, observation_id, observed_at, outcome)
        VALUES (?, ?, ?, 'DUPLICATE_OBSERVATION')
      `).run(runId, duplicate.id, retrievedAt);
      return { outcome: 'DUPLICATE_OBSERVATION', jobId: duplicate.job_id, observationId: duplicate.id, contentChanged: false, identity: resolution };
    }

    let previous = null;
    if (externalId) {
      previous = this.db.prepare(`
        SELECT * FROM job_observations
        WHERE job_id = ? AND provider = ? AND external_id = ? AND content_hash IS NOT NULL AND content_hash != ''
        ORDER BY first_observed_at DESC LIMIT 1
      `).get(jobId, provider, externalId);
    } else if (canonicalUrl || sourceUrl) {
      previous = this.db.prepare(`
        SELECT * FROM job_observations
        WHERE job_id = ? AND provider = ? AND (canonical_url = ? OR source_url = ?)
          AND content_hash IS NOT NULL AND content_hash != ''
        ORDER BY first_observed_at DESC LIMIT 1
      `).get(jobId, provider, canonicalUrl || '', sourceUrl || '');
    }
    const contentChanged = Boolean(previous && contentHash && previous.content_hash !== contentHash);
    const observationId = randomUUID();
    this.db.prepare(`
      INSERT INTO job_observations(
        id, job_id, first_run_id, provider, provider_version, external_id, source_url, canonical_url,
        title, company, location, description, content_hash, posted_at, first_observed_at, last_observed_at,
        extraction_method, confidence, observation_key, snapshot_hash, content_changed,
        identity_method, identity_confidence, identity_evidence_json, raw_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observationId, jobId, runId, provider, input.providerVersion || null, externalId || null,
      sourceUrl || null, canonicalUrl || null, title, company, location || null,
      input.description || null, contentHash || null, input.postedAt ? iso(input.postedAt, 'postedAt') : null,
      retrievedAt, retrievedAt, extractionMethod, confidence, observationKey, snapshotHash,
      contentChanged ? 1 : 0, resolution.method, resolution.confidence, json(resolution.evidence), json(input.rawMetadata),
    );

    this._addIdentity(jobId, 'external_id', provider, externalId, 'high', observationId, retrievedAt);
    this._addIdentity(jobId, 'canonical_url', '', canonicalUrl, 'high', observationId, retrievedAt);
    this._addIdentity(jobId, 'source_url', '', sourceUrl, 'high', observationId, retrievedAt);

    const defaultEvidence = ['title', 'company', 'location', 'canonicalUrl', 'externalId']
      .filter(field => normalized[field])
      .map(field => ({ field, value: normalized[field], confidence, extractionMethod }));
    const fieldEvidence = Array.isArray(input.evidence) ? input.evidence : defaultEvidence;
    for (const item of fieldEvidence) {
      this.db.prepare(`
        INSERT INTO job_field_evidence(
          observation_id, field_name, value_json, confidence, extraction_method, provider, source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observationId,
        String(item.field ?? ''),
        json(item.value, null),
        VALID_CONFIDENCE.has(item.confidence) ? item.confidence : confidence,
        VALID_EXTRACTION.has(item.extractionMethod) ? item.extractionMethod : extractionMethod,
        provider,
        sourceUrl || null,
        retrievedAt,
      );
    }

    this.db.prepare(`
      INSERT INTO run_observations(run_id, observation_id, observed_at, outcome)
      VALUES (?, ?, ?, ?)
    `).run(runId, observationId, retrievedAt, isNewJob ? 'NEW_JOB' : 'NEW_OBSERVATION');

    this.db.prepare(`
      UPDATE jobs SET
        canonical_title = CASE WHEN canonical_title = '' THEN ? ELSE canonical_title END,
        canonical_company = CASE WHEN canonical_company = '' THEN ? ELSE canonical_company END,
        canonical_url = COALESCE(canonical_url, ?),
        location = COALESCE(location, ?),
        last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      title, company, canonicalUrl || null,
      location || null, retrievedAt, retrievedAt, jobId,
    );

    return { outcome: isNewJob ? 'NEW_JOB' : 'NEW_OBSERVATION', jobId, observationId, contentChanged, identity: resolution };
  }

  _addIdentity(jobId, kind, namespace, value, confidence, observationId, createdAt) {
    if (!value) return false;
    const existing = this.db.prepare('SELECT job_id FROM job_identities WHERE kind = ? AND namespace = ? AND value = ?')
      .get(kind, namespace, value);
    if (existing) return existing.job_id === jobId;
    this.db.prepare(`
      INSERT INTO job_identities(job_id, kind, namespace, value, confidence, source_observation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, kind, namespace, value, confidence, observationId, createdAt);
    return true;
  }

  markSeen(runId, observationId, observedAt = this.now()) {
    const observation = this.db.prepare('SELECT * FROM job_observations WHERE id = ?').get(observationId);
    if (!observation) throw new Error(`unknown observation: ${observationId}`);
    const at = iso(observedAt, 'observedAt');
    this.db.transaction(() => {
      this.db.prepare('UPDATE job_observations SET last_observed_at = ?, seen_count = seen_count + 1 WHERE id = ?').run(at, observationId);
      this.db.prepare('UPDATE jobs SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(at, at, observation.job_id);
      this.db.prepare(`INSERT OR IGNORE INTO run_observations(run_id, observation_id, observed_at, outcome) VALUES (?, ?, ?, 'DUPLICATE_OBSERVATION')`)
        .run(runId, observationId, at);
    })();
  }

  close() {
    this.db.close();
  }
}

export function openJobRegistry(options) {
  return new JobRegistry(options);
}
