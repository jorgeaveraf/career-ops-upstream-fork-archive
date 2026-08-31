import { readFileSync } from 'fs';
import { openCandidateKnowledge } from '../candidate-knowledge/provider.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { HumanControlPlaneSync } from '../human-control-plane/sync.mjs';
import { ApplicationExecutionService } from '../application-execution/service.mjs';
import { OutreachExecutionService } from '../application-activation/service.mjs';
import { WorkerOrchestrator } from './worker-registry.mjs';

export async function reconcileSheetHumanInputs({registry,adapter,spreadsheetId,user='sheet-user',projectRoot=process.cwd(),clock=()=>new Date(),orchestrator=null,project=false,preserveHumanEdits=false}={}){
  if(!registry||!adapter||!spreadsheetId)throw new TypeError('registry, adapter, and spreadsheetId are required');
  const careerOpsVersion=readFileSync(new URL('../VERSION',import.meta.url),'utf8').trim().split(/\s+/)[0];
  const candidateKbVersion=openCandidateKnowledge({projectRoot}).getMetadata().version;
  const projectionOptions={spreadsheetId,careerOpsVersion,schemaVersion:registry.getSchemaVersion(),candidateKbVersion};
  const makeProjection=()=>buildControlPlaneProjection(registry.getControlPlaneData({spreadsheetId,candidateScope:'decision'}),projectionOptions);
  const sync=new HumanControlPlaneSync({registry,adapter,spreadsheetId,clock});
  const pull=await sync.pull(makeProjection(),{user});
  const applicationService=new ApplicationExecutionService({registry,clock});
  const outreachService=new OutreachExecutionService({registry,clock});
  const humanAnswers=applicationService.recordImportedHumanAnswers(pull.imported.applied);
  const authorization=applicationService.authorizeImportedActions(pull.imported.applied);
  const outreachAuthorization=outreachService.authorizeImportedActions(pull.imported.applied);
  outreachService.schedulePending();
  const coordinator=orchestrator||new WorkerOrchestrator({registry,clock});
  coordinator.materialize();
  const wake=coordinator.wakeRelevant({
    enrichment:pull.imported.applied.some(x=>x.field==='human_decision'&&x.value==='NEXT_STAGE'),
    application:authorization.authorizations.length>0||humanAnswers.length>0,
    outreach:outreachAuthorization.authorizations.length>0,
    reason:user==='daily-auto'?'SCHEDULED_RECONCILIATION':'MANUAL_SYNC',
  });
  const summary={status:'SUCCESS',imported:pull.imported.applied.length,rejected:pull.imported.applied.filter(x=>x.field==='human_decision'&&x.value==='REJECT').length,held:pull.imported.applied.filter(x=>x.field==='human_decision'&&x.value==='HOLD').length,enrichmentQueued:pull.imported.applied.filter(x=>x.field==='human_decision'&&x.value==='NEXT_STAGE').length,answersRecorded:humanAnswers.length,authorized:authorization.authorizations.length,authorizationRejected:authorization.rejected.length,outreachAuthorized:outreachAuthorization.authorizations.length,outreachRejected:outreachAuthorization.rejected.length,continuing:Object.values(wake).filter(x=>['WAKE_STARTED','ALREADY_RUNNING'].includes(x.result)).length,wake};
  const push=project?await sync.push(makeProjection(),{preserveHumanEdits}):null;
  return{pull,humanAnswers,authorization,outreachAuthorization,wake,summary,push,projectionDeferred:!project};
}
