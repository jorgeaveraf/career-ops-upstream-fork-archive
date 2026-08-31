import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowStatusService, formatWorkflowUpdatedAt, workflowStatusFromEvent } from '../workflow-status/service.mjs';
import { WorkflowCommandWorker } from '../operations/command-worker.mjs';

const NOW='2026-08-27T20:00:00.000Z';
const timeline=(jobEvents=[],communityEvents=[])=>({getForJob:()=>structuredClone(jobEvents),getForCommunity:()=>structuredClone(communityEvents),getRecent:()=>structuredClone(jobEvents)});

test('canonical events map deterministically to compact display statuses',()=>{
  assert.equal(workflowStatusFromEvent('ENRICHMENT_QUEUED'),'QUEUED');
  assert.equal(workflowStatusFromEvent('ENRICHMENT_STARTED'),'PROCESSING');
  assert.equal(workflowStatusFromEvent('APPLICATION_NEEDS_HUMAN'),'WAITING_FOR_HUMAN');
  assert.equal(workflowStatusFromEvent('ENRICHMENT_COMPLETED'),'READY_FOR_REVIEW');
  assert.equal(workflowStatusFromEvent('APPLICATION_CONFIRMED'),'COMPLETED');
  assert.equal(workflowStatusFromEvent('APPLICATION_FAILED'),'FAILED');
});

test('authoritative NEEDS_HUMAN wins over replay and exposes blocker text',()=>{
  const service=new WorkflowStatusService({timeline:timeline([{timestamp:'2026-08-27T19:00:00.000Z',eventType:'APPLICATION_EXECUTION_STARTED',summary:'Application execution started.',stage:'APPLY',correlationId:'c1'}]),clock:()=>new Date(NOW)});
  const status=service.resolveJobStatus('job-1',{execution:{status:'NEEDS_HUMAN',updatedAt:'2026-08-27T19:05:00.000Z',blocker:{code:'HUMAN_ONLY_QUESTION',question:'Are you legally authorized to work?'}}});
  assert.equal(status.stage,'APPLY');assert.equal(status.workflowStatus,'WAITING_FOR_HUMAN');assert.equal(status.attentionRequired,true);assert.equal(status.humanBlocker,'Are you legally authorized to work?');
});

test('verification unknown is generic, explicit, and forbids resubmission',()=>{
  const service=new WorkflowStatusService({timeline:timeline(),clock:()=>new Date(NOW)});
  const status=service.resolveJobStatus('job-2',{execution:{status:'NEEDS_HUMAN',updatedAt:'2026-08-27T19:05:00.000Z',blocker:{code:'VERIFICATION_UNKNOWN'}}});
  assert.equal(status.workflowStatus,'WAITING_FOR_HUMAN');assert.match(status.lastActivity,/external confirmation could not be verified/i);assert.doesNotMatch(status.lastActivity,/Supabase/i);
});

test('enrichment and application authoritative states cover ready, failed, and completed',()=>{
  const service=new WorkflowStatusService({timeline:timeline(),clock:()=>new Date(NOW)});
  assert.equal(service.resolveJobStatus('ready',{enrichment:{status:'READY_FOR_REVIEW',updatedAt:NOW}}).workflowStatus,'READY_FOR_REVIEW');
  assert.equal(service.resolveJobStatus('failed',{enrichment:{status:'FAILED',updatedAt:NOW,lastErrorCode:'FIXTURE'}}).workflowStatus,'FAILED');
  const applied=service.resolveJobStatus('applied',{execution:{status:'APPLIED',updatedAt:NOW,finishedAt:NOW}});assert.equal(applied.stage,'TRACK_LEARN');assert.equal(applied.workflowStatus,'COMPLETED');
});

test('untouched TOP work stays clean and idle',()=>{
  const status=new WorkflowStatusService({timeline:timeline(),clock:()=>new Date(NOW)}).resolveJobStatus('top');
  assert.equal(status.stage,'DISCOVER');assert.equal(status.workflowStatus,'IDLE');assert.equal(status.lastActivity,'');assert.equal(status.attentionRequired,false);
});

test('Last Updated renders in Spanish using America/Mexico_City',()=>{
  assert.equal(formatWorkflowUpdatedAt('2026-08-27T19:05:00.000Z',{now:new Date(NOW)}),'Hoy · 1:05 PM');
  assert.equal(formatWorkflowUpdatedAt('2026-08-26T19:05:00.000Z',{now:new Date(NOW)}),'Ayer · 1:05 PM');
});

test('resolution is idempotent for the same timeline and authoritative state',()=>{
  const service=new WorkflowStatusService({timeline:timeline(),clock:()=>new Date(NOW)}),input={enrichment:{status:'PENDING',updatedAt:NOW}};
  assert.deepEqual(service.resolveJobStatus('job',input),service.resolveJobStatus('job',input));
});

test('command SUCCESS remains distinct from a job WAITING_FOR_HUMAN outcome',()=>{
  const registry={getWorkflowCommand:()=>({commandId:'cmd',commandType:'jobs.sync',correlationId:'corr',status:'SUCCESS',resultSummary:'0 rejected · 1 executed',requestedAt:NOW,startedAt:NOW,completedAt:NOW})};
  const service=new WorkflowStatusService({registry,timeline:timeline(),clock:()=>new Date(NOW)});
  assert.equal(service.getCommandStatus('cmd').status,'SUCCESS');
  assert.equal(service.resolveJobStatus('job',{execution:{status:'NEEDS_HUMAN',updatedAt:NOW,blocker:{code:'VERIFICATION_UNKNOWN'}}}).workflowStatus,'WAITING_FOR_HUMAN');
});

test('community state resolves independently in the COMMUNITY stage',()=>{
  const registry={getFacebookCommunity:()=>({membershipState:'NEEDS_HUMAN',lastCheckedAt:NOW})};
  const service=new WorkflowStatusService({registry,timeline:timeline([],[]),clock:()=>new Date(NOW)}),status=service.getCommunityStatus('community');
  assert.equal(status.stage,'COMMUNITY');assert.equal(status.workflowStatus,'WAITING_FOR_HUMAN');assert.equal(status.attentionRequired,true);
});

test('command worker coalesces a deferred lifecycle projection into one final write',async()=>{
  let projections=0;const command={commandId:'cmd',commandType:'jobs.sync',correlationId:'corr',envelope:{sheet_id:'sheet'}};
  const registry={claimWorkflowCommand:()=>({claimed:true,command}),db:{prepare:()=>({get:()=>null})},completeWorkflowCommand:(_,{status})=>({...command,status})};
  const worker=new WorkflowCommandWorker({registry,dispatch:async()=>({projectionDeferred:true,summary:{rejected:0,held:0,enrichmentQueued:0,executed:0}}),projectStatus:async()=>{projections++;},logger:{info(){},error(){}}});
  assert.equal((await worker.process('cmd')).status,'SUCCESS');assert.equal(projections,1);
});
