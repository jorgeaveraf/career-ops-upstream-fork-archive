#!/usr/bin/env node
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { openJobRegistry, DEFAULT_REGISTRY_PATH } from './registry/job-registry.mjs';
import { ApplicationExecutionService } from './application-execution/service.mjs';
import { createProductionApplicationExecutors } from './application-execution/production-executors.mjs';
import { runApplicationExecutionBatch } from './application-execution/batch.mjs';
import { drainActionableNotifications } from './notifications/runtime.mjs';
import { WorkerOrchestrator } from './execution-orchestration/worker-registry.mjs';
import { rankOperationalCandidates } from './automation/operational-loop.mjs';
import { OutreachExecutionService } from './application-activation/service.mjs';
import { createProductionOutreachExecutors } from './outreach-execution/production-executors.mjs';
import { GoogleSheetsApiAdapter } from './human-control-plane/sheets-adapter.mjs';
import { HumanControlPlaneSync } from './human-control-plane/sync.mjs';
import { buildControlPlaneProjection } from './human-control-plane/projection.mjs';
import { createGoogleOAuthTokenProviderFromEnv } from './operations/google-oauth.mjs';
import { openCandidateKnowledge } from './candidate-knowledge/provider.mjs';
import { ApplicationConfirmationReconciler } from './application-execution/reconciliation.mjs';

function usage() { console.log('Usage:\n  npm run application:execute -- status [--job id]\n  npm run application:execute -- reconcile --execution id\n  npm run application:execute -- execute --authorization id [--correlation id]\n  npm run application:execute -- execute-batch --authorizations id,id [--correlation id]\n  npm run application:execute -- drain [--max-items 10] [--correlation id]\n\nReconcile is verification-only and can never submit. Execution requires exact persisted APPROVE_TO_APPLY authorization.'); }

async function refillToday({ registry, batch }) {
  const runId = `application-refill-${batch.id}`, clock = () => new Date(); if (!registry.getRun(runId)) registry.startRun({ id: runId, type: 'application-refill', startedAt: clock().toISOString(), metadata: { batchId: batch.id } });
  const before = new Set(registry.listActiveCandidates().map(item => item.jobId));
  const ranking = await rankOperationalCandidates({ registry, discoveryRunId: runId, profilePath: process.env.CAREER_OPS_PROFILE || 'config/profile.yml', portalsPath: process.env.CAREER_OPS_PORTALS || 'portals.yml', clock, limit: 100 });
  registry.finishRun(runId, { status: 'SUCCESS', finishedAt: clock().toISOString(), metadata: { batchId: batch.id } });
  const after = registry.listActiveCandidates(), promoted = after.filter(item => !before.has(item.jobId)).length;
  return { promoted, reranked: true, active: after.length, top10: ranking.top10?.length || 0, runId };
}

async function continueApprovedOutreach({ registry, applied }) {
  const service = new OutreachExecutionService({ registry, executors: createProductionOutreachExecutors() }); service.schedulePending(); const results = [];
  for (const appliedResult of applied) { const execution = appliedResult.execution || appliedResult; for (const authorization of registry.listOutreachAuthorizations({ jobId: execution.jobId }).filter(item => item.status === 'APPROVED_OUTREACH')) results.push(await service.execute({ authorizationId: authorization.id })); }
  return { sent: results.filter(item => item.status === 'SENT').length, manual: results.filter(item => item.status === 'NEEDS_HUMAN').length, results };
}

async function projectLiveSheet({ registry }) {
  const spreadsheetId = process.env.CAREER_OPS_SHEET_ID; if (!spreadsheetId) return { synced: false, reason: 'SHEET_NOT_CONFIGURED' };
  const adapter = new GoogleSheetsApiAdapter({ spreadsheetId, tokenProvider: createGoogleOAuthTokenProviderFromEnv() }), sync = new HumanControlPlaneSync({ registry, adapter, spreadsheetId });
  const projection = buildControlPlaneProjection(registry.getControlPlaneData({ spreadsheetId, candidateScope: 'decision' }), { spreadsheetId, careerOpsVersion: readFileSync('VERSION', 'utf8').trim().split(/\s+/)[0], schemaVersion: registry.getSchemaVersion(), candidateKbVersion: openCandidateKnowledge({ projectRoot: process.cwd() }).getMetadata().version });
  return sync.push(projection, { preserveHumanEdits: true });
}

async function main() {
  const args = process.argv.slice(2), command = args[0]; if (!command || args.includes('--help')) return usage();
  const registry = openJobRegistry({ dbPath: flagValue(args, '--db') || process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH });
  try {
    if (command === 'status') { const jobId = flagValue(args, '--job'); console.log(JSON.stringify({ authorizations: registry.listApplicationExecutionAuthorizations({ jobId }), executions: registry.listApplicationExecutions({ jobId }), accounts: registry.listPlatformAccounts() }, null, 2)); return; }
    if(command==='reconcile'){const executionId=flagValue(args,'--execution');if(!executionId)throw new Error('--execution is required');const result=new ApplicationConfirmationReconciler({registry}).reconcile(executionId);let refill=null,projection=null;if(result.status==='RECONCILED'){refill=await refillToday({registry,batch:{id:`confirmation-reconciliation-${executionId}`}});projection=await projectLiveSheet({registry});}console.log(JSON.stringify({...result,refill,projection},null,2));return;}
    const service = new ApplicationExecutionService({ registry, executors: createProductionApplicationExecutors({ registry }) }), correlationId = flagValue(args, '--correlation') || `application-iteration-${randomUUID()}`,notify=command==='drain'?args.includes('--notify'):!args.includes('--no-notify');
    if (command === 'execute') { const id = flagValue(args, '--authorization'); if (!id) throw new Error('--authorization is required'); const result = await runApplicationExecutionBatch({ registry, service, authorizationIds: [id], correlationId, refill: input => refillToday({ registry, ...input }), continueOutreach: input => continueApprovedOutreach({ registry, ...input }), project: () => projectLiveSheet({ registry }),notify }); const notifications = notify?await drainActionableNotifications({ registry }):{status:'SKIPPED'}; console.log(JSON.stringify({ ...result, notifications }, null, 2)); return; }
    if (command === 'execute-batch') { const ids = String(flagValue(args, '--authorizations') || '').split(',').map(value => value.trim()).filter(Boolean); if (!ids.length) throw new Error('--authorizations is required'); const result = await runApplicationExecutionBatch({ registry, service, authorizationIds: ids, correlationId, refill: input => refillToday({ registry, ...input }), continueOutreach: input => continueApprovedOutreach({ registry, ...input }), project: () => projectLiveSheet({ registry }),notify }); const notifications = notify?await drainActionableNotifications({ registry }):{status:'SKIPPED'}; console.log(JSON.stringify({ ...result, notifications }, null, 2)); return; }
    if (command === 'drain') {
      const orchestrator = new WorkerOrchestrator({ registry }); orchestrator.materialize(); const items = orchestrator.queue('APPLICATION').slice(0, Math.max(1, Number(flagValue(args, '--max-items') || 10)));
      for (const item of items) orchestrator.claim(item.workKey);
      const result = await runApplicationExecutionBatch({ registry, service, authorizationIds: items.map(item => item.aggregateId), correlationId, refill: input => refillToday({ registry, ...input }), continueOutreach: input => continueApprovedOutreach({ registry, ...input }), project: () => projectLiveSheet({ registry }),notify });
      for (let index = 0; index < items.length; index++) orchestrator.complete(items[index].workKey, result.results[index] || { status: 'NO_WORK' });
      const notifications = notify?await drainActionableNotifications({ registry }):{status:'SKIPPED'}; console.log(JSON.stringify({ ...result, claimed: items.length, notifications }, null, 2)); return;
    }
    throw new Error(`unknown command: ${command}`);
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`Application execution failed: ${error.message}`); process.exitCode = 1; });
