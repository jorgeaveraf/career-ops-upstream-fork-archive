import { randomUUID } from 'crypto';
import { renderActionableNotification } from '../notifications/templates.mjs';
import { validateNotificationPreferences } from '../notifications/preferences.mjs';

const nowIso = clock => clock().toISOString();

export function enqueueApplicationBatchDigest({ registry, batch, results, todayPromoted = 0, outreach = { sent: 0, manual: 0 } } = {}) {
  const outbox = registry.notificationOutbox, db = registry.db, recipient = outbox.preferences.recipient || 'unconfigured';
  const dedupeKey = `application-batch-digest:${batch.correlationId}:${recipient.toLowerCase()}`, existing = outbox.getByDedupeKey(dedupeKey); if (existing) return { ...existing, existing: true };
  const rows = results.map(result => { const execution = result?.execution || result, job = execution?.jobId ? db.prepare('SELECT canonical_company company,canonical_title role FROM jobs WHERE id=?').get(execution.jobId) : null,handoff=execution?.id?registry.getActiveHumanHandoffForExecution(execution.id):null; return { company: job?.company || 'Oportunidad', role: job?.role || '', status: execution?.status || result?.status || 'UNKNOWN', action:handoff?.action||'Open TODAY',instruction:handoff?.instruction||'',questionCount:handoff?.questions?.length||0 }; });
  const context = { applied: rows.filter(x => x.status === 'APPLIED'), blocked: rows.filter(x => ['NEEDS_HUMAN','BLOCKED'].includes(x.status)), failed: rows.filter(x => x.status === 'FAILED'), todayPromoted, outreach, sheetUrl: outbox.sheetUrl };
  const rendered = renderActionableNotification('APPLICATION_BATCH_DIGEST', context), id = randomUUID(), at = outbox.now(), enabled = outbox.preferences.enabled && outbox.preferences.workflowDigests !== false && validateNotificationPreferences(outbox.preferences).ok;
  const snapshot = { batchId: batch.id, requestIds: results.map(result => { const execution = result?.execution || result; return execution?.jobId ? registry.listEnrichmentRequests({ jobId: execution.jobId }).at(-1)?.id : null; }).filter(Boolean), executionIds: results.map(x => (x.execution || x)?.id).filter(Boolean) };
  db.prepare(`INSERT INTO notification_deliveries(id,event_id,aggregate_type,aggregate_id,correlation_id,notification_type,priority,channel,recipient_identity,provider,status,subject,body_text,template_version,trigger_snapshot_json,error_code,error,attempt_count,max_attempts,next_attempt_at,created_at,dedupe_key) VALUES(?,NULL,'APPLICATION_BATCH',?,?,'WORKFLOW_DIGEST','NORMAL','email',?,?,?,?,?,?,?,?,?,0,3,?,?,?)`).run(id,batch.id,batch.correlationId,recipient,outbox.providerId,enabled?'PENDING':'DISABLED',rendered.subject,rendered.text,rendered.templateVersion,JSON.stringify(snapshot),enabled?null:'WORKFLOW_DIGEST_DISABLED',enabled?null:'Workflow digests are disabled',enabled?at:null,at,dedupeKey);
  return outbox.get(id);
}

export async function runApplicationExecutionBatch({ registry, service, authorizationIds = [], correlationId = `application-iteration-${randomUUID()}`, clock = () => new Date(), refill = null, continueOutreach = null, project = null, notify = true } = {}) {
  if (!registry || !service) throw new TypeError('registry and service are required');
  const batch = registry.beginApplicationBatch({ correlationId, source: 'APPLICATION_WORKER' }), results = [];
  for (const authorizationId of [...new Set(authorizationIds)]) {
    try { const result = (await service.process({ authorizationId, batchId: batch.id, maxApplications: 1 })).results[0] || { status: 'NO_WORK' }; results.push(result); }
    catch (error) { results.push({ status: 'FAILED', authorizationId, reason: error.message, blocker: { code: error.code || 'EXECUTION_ERROR' } }); }
  }
  const applied = results.filter(result => (result.execution || result)?.status === 'APPLIED');
  const refillResult = applied.length && refill ? await refill({ batch, applied, results }) : { promoted: 0, reranked: false };
  const outreachResult = continueOutreach ? await continueOutreach({ batch, applied, results }) : { sent: 0, manual: 0, results: [] };
  const projection = project ? await project({ batch, results, refill: refillResult, outreach: outreachResult }) : null;
  const summary = { attempted: results.length, applied: applied.length, blocked: results.filter(x => ['NEEDS_HUMAN','BLOCKED'].includes((x.execution||x)?.status)).length, failed: results.filter(x => (x.execution||x)?.status === 'FAILED').length, todayPromoted: Number(refillResult?.promoted || 0), outreachSent: Number(outreachResult?.sent || 0), completedAt: nowIso(clock) };
  let delivery = null; if (notify && results.length) delivery = enqueueApplicationBatchDigest({ registry, batch, results, todayPromoted: summary.todayPromoted, outreach: outreachResult });
  const status = summary.failed ? 'PARTIAL' : 'COMPLETED'; registry.finishApplicationBatch(batch.id, { status, summary, notificationDeliveryId: delivery?.id || null });
  return { status, batch: registry._applicationBatchRow(registry.db.prepare('SELECT * FROM application_execution_batches WHERE id=?').get(batch.id)), results, refill: refillResult, outreach: outreachResult, projection, notification: delivery };
}
