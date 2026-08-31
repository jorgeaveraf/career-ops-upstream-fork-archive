import { readFileSync } from 'fs';
import { openCandidateKnowledge } from '../candidate-knowledge/provider.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { GoogleSheetsApiAdapter } from '../human-control-plane/sheets-adapter.mjs';
import { HumanControlPlaneSync } from '../human-control-plane/sync.mjs';
import { createGoogleOAuthTokenProviderFromEnv } from './google-oauth.mjs';
import { dispatchWorkflowCommand, summarizeCommandResult } from './command-dispatch.mjs';
import { workflowEventContext } from '../workflow-events/writer.mjs';
import { drainActionableNotifications } from '../notifications/runtime.mjs';

export async function pushCommandStatus({ registry, spreadsheetId, preserveHumanEdits = true } = {}) {
  const adapter = new GoogleSheetsApiAdapter({ spreadsheetId, tokenProvider: createGoogleOAuthTokenProviderFromEnv() });
  const careerOpsVersion = readFileSync('VERSION', 'utf8').trim().split(/\s+/)[0];
  const candidateKbVersion = openCandidateKnowledge({ projectRoot: process.cwd() }).getMetadata().version;
  const projection = buildControlPlaneProjection(registry.getControlPlaneData({ spreadsheetId, candidateScope: 'decision' }), {
    spreadsheetId, careerOpsVersion, schemaVersion: registry.getSchemaVersion(), candidateKbVersion,
  });
  return new HumanControlPlaneSync({ registry, adapter, spreadsheetId }).push(projection, { preserveHumanEdits });
}

export class WorkflowCommandWorker {
  constructor({ registry, dispatch = dispatchWorkflowCommand, projectStatus = pushCommandStatus, deliverNotifications = drainActionableNotifications, logger = console } = {}) {
    if (!registry || typeof dispatch !== 'function') throw new TypeError('registry and dispatch are required');
    this.registry = registry; this.dispatch = dispatch; this.projectStatus = projectStatus; this.deliverNotifications=deliverNotifications; this.logger = logger;
  }

  async process(commandId) {
    const claim = this.registry.claimWorkflowCommand(commandId);
    if (!claim.claimed) return { status: 'IGNORED_DUPLICATE', command: claim.command };
    const started = Date.now();
    this.logger.info?.(JSON.stringify({ event: 'command_processing', commandId, commandType: claim.command.commandType, correlationId: claim.command.correlationId }));
    const startedEvent = this.registry.db.prepare("SELECT event_id FROM workflow_events WHERE dedupe_key=?").get(`command:${commandId}:started`);
    return workflowEventContext.run({ correlationId:claim.command.correlationId, commandId, causationId:startedEvent?.event_id || commandId }, async()=>{try {
      const result = await this.dispatch(claim.command, { registry: this.registry });
      const status = result?.status === 'NEEDS_HUMAN' ? 'NEEDS_HUMAN' : 'SUCCESS';
      const resultSummary = summarizeCommandResult(claim.command.commandType, result);
      const command = this.registry.completeWorkflowCommand(commandId, { status, resultSummary });
      if(this.registry.notificationOutbox)try{await this.deliverNotifications?.({registry:this.registry,env:this.registry.env});}catch(notificationError){this.logger.error?.(JSON.stringify({event:'notification_delivery_failed',commandId,errorCode:notificationError.code||'NOTIFICATION_DELIVERY_FAILED'}));}
      if(!result?.deliveryProbe)await this.projectStatus?.({ registry: this.registry, spreadsheetId: command.envelope.sheet_id, preserveHumanEdits:false });
      this.logger.info?.(JSON.stringify({ event: 'command_processed', commandId, commandType: command.commandType, correlationId: command.correlationId, status, durationMs: Date.now() - started }));
      return { status, command, result };
    } catch (error) {
      const command = this.registry.completeWorkflowCommand(commandId, { status: 'FAILED', errorCode: error.code || 'COMMAND_FAILED', errorMessage: error.message });
      if(this.registry.notificationOutbox)try{await this.deliverNotifications?.({registry:this.registry,env:this.registry.env});}catch(notificationError){this.logger.error?.(JSON.stringify({event:'notification_delivery_failed',commandId,errorCode:notificationError.code||'NOTIFICATION_DELIVERY_FAILED'}));}
      try { await this.projectStatus?.({ registry: this.registry, spreadsheetId: command.envelope.sheet_id }); } catch (projectionError) { this.logger.error?.(JSON.stringify({ event: 'command_status_projection_failed', commandId, error: projectionError.message })); }
      this.logger.error?.(JSON.stringify({ event: 'command_failed', commandId, commandType: command.commandType, correlationId: command.correlationId, errorCode: command.errorCode, durationMs: Date.now() - started }));
      return { status: 'FAILED', command, error };
    }});
  }

  async recover() {
    const pending = this.registry.listWorkflowCommands({ statuses: ['RECEIVED','PROCESSING'], limit: 1000 }).reverse();
    const results = [];
    for (const command of pending) results.push(await this.process(command.commandId));
    return results;
  }
}
