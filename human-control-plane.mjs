#!/usr/bin/env node

import 'dotenv/config';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { openCandidateKnowledge } from './candidate-knowledge/provider.mjs';
import { buildControlPlaneProjection } from './human-control-plane/projection.mjs';
import { GoogleSheetsApiAdapter } from './human-control-plane/sheets-adapter.mjs';
import { HumanControlPlaneSync } from './human-control-plane/sync.mjs';
import { flagValue } from './lib/cli-flags.mjs';
import { DEFAULT_REGISTRY_PATH, openJobRegistry } from './registry/job-registry.mjs';
import { createGoogleOAuthTokenProviderFromEnv } from './operations/google-oauth.mjs';
import { runJobsSync } from './operations/command-dispatch.mjs';
import { commandPayloadHash, deterministicLegacyCommandId } from './operations/command-contract.mjs';
import { WorkflowCommandWorker } from './operations/command-worker.mjs';

function usage() {
  console.log(`Usage:
  node human-control-plane.mjs init [--sheet id] [--db path]
  node human-control-plane.mjs preview [--sheet id] [--db path]
  node human-control-plane.mjs push [--sheet id] [--db path]
  node human-control-plane.mjs pull [--sheet id] [--db path] [--user name]
  node human-control-plane.mjs sync [--sheet id] [--db path] [--user name]
  node human-control-plane.mjs sync-jobs [--sheet id] [--db path] [--user name] [--require-request]
  node human-control-plane.mjs apps-script

Google API commands require renewable Google OAuth configuration. SQLite remains authoritative;
pull imports only allowlisted human-owned fields and rejects Career Ops fields.`);
}

async function main() {
  const args = process.argv.slice(2); const command = args[0];
  if (!command || ['-h', '--help'].includes(command)) { usage(); return; }
  if (command === 'apps-script') { console.log(readFileSync(new URL('./human-control-plane/apps-script/Code.gs', import.meta.url), 'utf8')); return; }
  const spreadsheetId = flagValue(args, '--sheet') || process.env.CAREER_OPS_SHEET_ID;
  if (!spreadsheetId) throw new Error('missing --sheet or CAREER_OPS_SHEET_ID');
  const adapter = command === 'preview' ? null : new GoogleSheetsApiAdapter({ spreadsheetId, tokenProvider: createGoogleOAuthTokenProviderFromEnv() });
  if (command === 'init') { console.log(JSON.stringify(await adapter.initialize(), null, 2)); return; }
  if (!['preview', 'push', 'pull', 'sync', 'sync-jobs'].includes(command)) throw new Error(`unknown command: ${command}`);
  const dbPath = flagValue(args, '--db') || process.env.CAREER_OPS_DB || DEFAULT_REGISTRY_PATH;
  const registry = openJobRegistry({ dbPath });
  try {
    if (command === 'sync-jobs' && !args.includes('--require-request')) {
      console.log(JSON.stringify(await runJobsSync({ registry, spreadsheetId, user: flagValue(args, '--user') || process.env.USER || 'sheet-user' }), null, 2));
      return;
    }
    const careerOpsVersion = readFileSync('VERSION', 'utf8').trim().split(/\s+/)[0];
    const data = registry.getControlPlaneData({ spreadsheetId, candidateScope: 'decision' });
    const candidateKbVersion = openCandidateKnowledge({ projectRoot: process.cwd() }).getMetadata().version;
    const projection = buildControlPlaneProjection(data, {
      spreadsheetId, careerOpsVersion,
      schemaVersion: registry.getSchemaVersion(), candidateKbVersion,
    });
    if (command === 'preview') { console.log(JSON.stringify(projection, null, 2)); return; }
    const sync = new HumanControlPlaneSync({ registry, adapter, spreadsheetId });
    const result = {};
    if(command==='sync-jobs'&&args.includes('--require-request')){const settings=await adapter.readTab('SETTINGS');const header=settings[0]||[],key=header.indexOf('Key'),value=header.indexOf('Value');const row=settings.slice(1).find(item=>item[key]==='Job Sync Requested At');const requestedAt=String(row?.[value]||'').trim();if(!requestedAt){console.log(JSON.stringify({status:'SKIPPED',reason:'no_job_sync_request'},null,2));return;}if(registry.hasWorkflowRequestReceipt('JOB_SYNC',requestedAt)){console.log(JSON.stringify({status:'SKIPPED',reason:'request_already_processed',requestedAt},null,2));return;}const commandId=deterministicLegacyCommandId(`jobs.sync:${spreadsheetId}:${requestedAt}`),envelope={command_version:'3A.1',command_id:commandId,command_type:'jobs.sync',requested_at:requestedAt,source:'google_sheet_legacy_polling',sheet_id:spreadsheetId,requested_by:flagValue(args,'--user')||process.env.USER||'sheet-user',correlation_id:commandId,payload:{legacy_transport:true}};registry.receiveWorkflowCommand({envelope,payloadHash:commandPayloadHash(envelope)});const processed=await new WorkflowCommandWorker({registry}).process(commandId);registry.recordWorkflowRequestReceipt({requestType:'JOB_SYNC',requestedAt,status:processed.status,result:processed.result?.summary||{}});console.log(JSON.stringify({requestedAt,legacyTransport:true,...processed},null,2));return;}
    if (command === 'pull' || command === 'sync') result.pull = await sync.pull(projection, { user: flagValue(args, '--user') || process.env.USER || 'sheet-user' });
    if (command === 'push' || command === 'sync') {
      const refreshed = buildControlPlaneProjection(registry.getControlPlaneData({ spreadsheetId, candidateScope: 'decision' }), {
        spreadsheetId, careerOpsVersion, schemaVersion: registry.getSchemaVersion(), candidateKbVersion,
      });
      result.push = await sync.push(refreshed, { preserveHumanEdits: command !== 'sync' });
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { registry.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
