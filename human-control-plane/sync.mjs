import { CONTROL_PLANE_TABS } from './contracts.mjs';
import { collectHumanActions } from './human-actions.mjs';
import { matrixToRowsLoose, mergeProjectionRows, rowsToMatrix } from './projection.mjs';
import { randomUUID } from 'crypto';
import { workflowEventContext } from '../workflow-events/writer.mjs';
import { HumanAttentionService } from '../human-attention/service.mjs';

export class HumanControlPlaneSync {
  constructor({ registry, adapter, spreadsheetId, clock = () => new Date() } = {}) {
    if (!registry || !adapter || !spreadsheetId) throw new TypeError('registry, adapter, and spreadsheetId are required');
    this.registry = registry; this.adapter = adapter; this.spreadsheetId = spreadsheetId; this.clock = clock;
  }
  async push(projection, { preserveHumanEdits = true } = {}) {
    const syncedAt = this.clock().toISOString();
    const id=randomUUID(); this._started(id,'PUSH',syncedAt);
    try {
      const initialized=await this.adapter.initialize(),metrics={dataMutations:0,structuralMutations:Number(initialized?.structuralMutations||0),tabsChanged:0,ranges:0};
      const settings = new Map((projection.tabs.SETTINGS || []).map(row => [row.Key, row.Value]));
      const command = (projection.tabs.TODAY || []).find(row => row['Last Command'] || row['Command Status']) || {};
      const todaySummary = { needsAttention: settings.get('Needs Your Attention') ?? 0, status: settings.get('Career Ops Status') || 'UNKNOWN', lastCommand: settings.get('Last Command') || command['Last Command'] || 'NONE', commandStatus: settings.get('Command Status') || command['Command Status'] || '', lastDailyCompletion: settings.get('Last Daily Summary') || 'NONE' };
      for (const name of CONTROL_PLANE_TABS) {
        const existingMatrix = await this.adapter.readTab(name);
        let existing = [];
        if (existingMatrix.length) existing = matrixToRowsLoose(name, existingMatrix);
        const projected = projection.tabs[name];
        // Background projections must not erase edits that have not been pulled yet.
        // After a successful pull, however, the registry is authoritative: retaining
        // the old cells can replay the same decision on the next Sync command,
        // especially when a job appears in both TODAY and PIPELINE.
        const merged = preserveHumanEdits ? mergeProjectionRows(name, projected, existing) : projected;
        const mutation=await this.adapter.writeTab(name, rowsToMatrix(name, merged), name === 'TODAY' ? { summary: todaySummary } : undefined)||{};
        metrics.dataMutations+=Number(mutation.dataMutations||0);metrics.structuralMutations+=Number(mutation.structuralMutations||0);metrics.ranges+=Number(mutation.ranges||0);if(Number(mutation.dataMutations||0)||Number(mutation.structuralMutations||0))metrics.tabsChanged++;
      }
      const sync=this.registry.recordSheetSync({ id, spreadsheetId: this.spreadsheetId, direction: 'PUSH', projectionHash: projection.hash, syncedAt, result: { tabs: CONTROL_PLANE_TABS,...metrics,noOp:metrics.dataMutations===0&&metrics.structuralMutations===0 } });
      return{...sync,metrics,noOp:metrics.dataMutations===0&&metrics.structuralMutations===0};
    } catch(error){this._failed(id,'PUSH',error);throw error;}
  }
  async pull(projection, { user = 'sheet-user' } = {}) {
    const id=randomUUID(),startedAt=this.clock().toISOString(); this._started(id,'PULL',startedAt);
    try { const sheetRows = {};
      for (const name of CONTROL_PLANE_TABS) sheetRows[name] = matrixToRowsLoose(name, await this.adapter.readTab(name));
      const actions = collectHumanActions({ projection, sheetRows, spreadsheetId: this.spreadsheetId, observedAt: startedAt, user });
      const imported = this.registry.recordHumanActions(actions);
      const attention = new HumanAttentionService({registry:this.registry,clock:this.clock});
      const resolutions = imported.applied.map(action=>attention.resolveImportedAction(action)).filter(result=>result.status!=='NOT_APPLICABLE');
      const sync = this.registry.recordSheetSync({ id, spreadsheetId: this.spreadsheetId, direction: 'PULL', projectionHash: projection.hash, syncedAt: this.clock().toISOString(), result: { imported: imported.applied.length, rejected: actions.rejected.length } });
      return { ...actions, imported, resolutions, sync };
    } catch(error){this._failed(id,'PULL',error);throw error;}
  }
  _started(id,direction,at){this.registry.recordWorkflowEvent({eventType:'SHEET_SYNC_STARTED',aggregateType:'SHEET_SYNC',aggregateId:id,correlationId:workflowEventContext.getStore()?.correlationId||`sheet-sync:${id}`,occurredAt:at,source:'sheet',actorType:'SYSTEM',payload:{direction,projectionNames:CONTROL_PLANE_TABS},metadata:{refs:{spreadsheetId:this.spreadsheetId,syncRunId:id}},dedupeKey:`sheet-sync:${id}:started`});}
  _failed(id,direction,error){this.registry.recordWorkflowEvent({eventType:'SHEET_SYNC_FAILED',aggregateType:'SHEET_SYNC',aggregateId:id,correlationId:workflowEventContext.getStore()?.correlationId||`sheet-sync:${id}`,source:'sheet',actorType:'SYSTEM',payload:{direction,status:'FAILED',errorCode:error.code||'SHEET_SYNC_FAILED'},metadata:{refs:{spreadsheetId:this.spreadsheetId,syncRunId:id}},dedupeKey:`sheet-sync:${id}:failed`});}
}
