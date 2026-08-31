import { GoogleSheetsApiAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { runFacebookCommunitySync } from '../facebook.mjs';
import { createGoogleOAuthTokenProviderFromEnv } from './google-oauth.mjs';
import { randomUUID } from 'crypto';
import { reconcileSheetHumanInputs } from '../execution-orchestration/reconciler.mjs';

export async function runJobsSync({ registry, spreadsheetId, user = process.env.USER || 'sheet-user', project = true } = {}) {
  if (!registry || !spreadsheetId) throw new TypeError('registry and spreadsheetId are required');
  const adapter = new GoogleSheetsApiAdapter({ spreadsheetId, tokenProvider: createGoogleOAuthTokenProviderFromEnv() });
  return reconcileSheetHumanInputs({registry,adapter,spreadsheetId,user,project,projectRoot:process.cwd(),preserveHumanEdits:false});
}

export async function dispatchWorkflowCommand(command, { registry } = {}) {
  if (command.envelope.payload?.delivery_probe === true) {
    const id=randomUUID(),at=registry.now();
    const started=registry.recordWorkflowEvent({eventType:'SHEET_SYNC_STARTED',aggregateType:'SHEET_SYNC',aggregateId:id,source:'sheet',actorType:'SYSTEM',occurredAt:at,payload:{direction:'NO_OP',projectionNames:[]},metadata:{refs:{spreadsheetId:command.envelope.sheet_id,syncRunId:id}},dedupeKey:`sheet-sync:${id}:started`});
    registry.recordWorkflowEvent({eventType:'SHEET_SYNC_COMPLETED',aggregateType:'SHEET_SYNC',aggregateId:id,source:'sheet',actorType:'SYSTEM',occurredAt:registry.now(),causationId:started.event.event_id,payload:{direction:'NO_OP',projectionNames:[],counts:{imported:0,rejected:0},result:'NO_WORKFLOW_MUTATION'},metadata:{refs:{spreadsheetId:command.envelope.sheet_id,syncRunId:id}},dedupeKey:`sheet-sync:${id}:completed`});
    return { status: 'SUCCESS', deliveryProbe: true };
  }
  const sheetId = command.envelope.sheet_id || process.env.CAREER_OPS_SHEET_ID;
  if (command.commandType === 'jobs.sync') return runJobsSync({ registry, spreadsheetId: sheetId, user: command.envelope.requested_by, project:false });
  if (command.commandType === 'communities.sync') return runFacebookCommunitySync({
    registry, dbPath: registry.dbPath, spreadsheetId: sheetId, user: command.envelope.requested_by, project:false,
  });
  throw new TypeError(`unsupported command type: ${command.commandType}`);
}

export function summarizeCommandResult(commandType, result) {
  if (result.deliveryProbe) return 'Delivery probe completed · no workflow mutation';
  if (commandType === 'jobs.sync') return `${result.summary.imported} imported · ${result.summary.rejected} rejected · ${result.summary.held} held · ${result.summary.enrichmentQueued} enrichment queued · ${result.summary.authorized} applications queued · ${result.summary.outreachAuthorized} outreach queued · ${result.summary.continuing} workers continuing`;
  return `${result.decisionsImported || 0} decisions processed · ${result.clicked || 0} join clicks`;
}
