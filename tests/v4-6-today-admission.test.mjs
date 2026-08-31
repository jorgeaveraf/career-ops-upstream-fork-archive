import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTodayMembership, TODAY_TARGET } from '../human-control-plane/today-membership.mjs';
import { projectHumanState } from '../human-control-plane/human-state.mjs';
import { buildControlPlaneProjection, mergeProjectionRows } from '../human-control-plane/projection.mjs';
import { deriveHumanAttentionItems } from '../human-attention/service.mjs';
import { detectOperationalSignals } from '../operational-intelligence/detectors.mjs';

const NOW='2026-08-31T18:00:00.000Z';
const job=(index,{recommendation='APPLY',eligibility='ELIGIBLE',decision='SHORTLIST',priority=100-index,status='VALID'}={})=>({
  job:{id:`job-${index}`,company:`Company ${index}`,title:`Role ${index}`,location:'Remote — Mexico',url:`https://example.test/${index}`,lastSeenAt:NOW},
  assessment:{eligibilityStatus:eligibility,decision,finalPriorityScore:priority,result:{candidateFit:{score:priority,reasons:['fit']}}},
  evaluation:recommendation?{status,recommendation,confidence:'HIGH'}:null,
});
const data=(jobs,humanState=[],extra={})=>({
  jobs,humanState,enrichmentRequests:[],applicationExecutions:[],humanHandoffs:[],contacts:[],contactResearch:[],communities:[],workflowStatuses:[],communityWorkflowStatuses:[],
  candidateSelection:{snapshot:jobs.map((value,index)=>({jobId:value.job.id,rank:index+1,eligibilityStatus:value.assessment.eligibilityStatus,decision:value.assessment.decision,finalPriorityScore:value.assessment.finalPriorityScore})),activeCandidates:jobs.map(value=>({jobId:value.job.id,state:'ACTIVE'})),researchNeeds:[],top10:[]},
  ...extra,
});
const state=(id,field,value)=>({entityType:'JOB',entityId:id,field,value});

test('V4.6 target is ten total rows and 9 + admissible candidate fills to 10',()=>{
  const result=selectTodayMembership(data(Array.from({length:10},(_,i)=>job(i))));
  assert.equal(TODAY_TARGET,10);assert.equal(result.members.length,10);assert.equal(result.outcome,'FILLED');
  assert.deepEqual(result.memberJobIds,Array.from({length:10},(_,i)=>`job-${i}`));
});

test('9 TODAY plus no admissible remainder stays 9 with deterministic exhaustion',()=>{
  const jobs=[...Array.from({length:9},(_,i)=>job(i)),job(9,{recommendation:'DO_NOT_APPLY'})];
  const result=selectTodayMembership(data(jobs));
  assert.equal(result.members.length,9);assert.equal(result.outcome,'EXHAUSTED');assert.equal(result.diagnostics.vacantSlots,1);
  assert.equal(result.diagnostics.trace.find(x=>x.jobId==='job-9').exactRule,'MACHINE_DO_NOT_APPLY_WITHOUT_UNRESOLVED_HUMAN_WORK');
});

test('terminal application and Human rejection release a slot and refill from highest priority',()=>{
  const jobs=Array.from({length:11},(_,i)=>job(i));
  const applied=selectTodayMembership(data(jobs,[],{applicationExecutions:[{jobId:'job-0',status:'APPLIED'}]}));
  assert.equal(applied.members.length,10);assert.equal(applied.memberJobIds.includes('job-0'),false);assert.equal(applied.memberJobIds.at(-1),'job-10');
  const rejected=selectTodayMembership(data(jobs,[state('job-0','human_decision','REJECT')]));
  assert.equal(rejected.members.length,10);assert.equal(rejected.memberJobIds.includes('job-0'),false);assert.equal(rejected.memberJobIds.at(-1),'job-10');
});

test('explicit HOLD is HELD_VISIBLE, consumes capacity, and does not manufacture attention',()=>{
  const input=data([job(0)],[state('job-0','human_decision','HOLD')]);
  const membership=selectTodayMembership(input),projection=buildControlPlaneProjection(input),row=projection.tabs.TODAY[0];
  assert.equal(membership.members[0].admissionReason,'HELD_VISIBLE');assert.equal(membership.members.length,1);
  assert.equal(deriveHumanAttentionItems(input).length,0);assert.equal(row.Status,'ON_HOLD');assert.equal(row['Attention Type'],'');
  assert.equal(projection.tabs.SETTINGS.find(x=>x.Key==='Needs Your Attention').Value,0);
});

test('pinned background work consumes a slot and outranks new curated decisions',()=>{
  const jobs=Array.from({length:11},(_,i)=>job(i));
  const input=data(jobs,[state('job-10','human_decision','NEXT_STAGE')],{enrichmentRequests:[{jobId:'job-10',status:'PENDING'}]});
  const membership=selectTodayMembership(input);
  assert.equal(membership.members.length,10);assert.equal(membership.memberJobIds.includes('job-10'),true);
  assert.equal(membership.members.find(x=>x.jobId==='job-10').admissionReason,'PINNED');assert.equal(membership.memberJobIds.includes('job-9'),false);
});

test('one vacant slot selects the deterministic highest-priority admissible candidate',()=>{
  const jobs=[...Array.from({length:9},(_,i)=>job(i)),job(9,{priority:70}),job(10,{priority:80})];
  const membership=selectTodayMembership(data(jobs));
  assert.equal(membership.memberJobIds.includes('job-10'),true);assert.equal(membership.memberJobIds.includes('job-9'),false);
});

test('hard stops and duplicate canonical IDs never fill capacity',()=>{
  const jobs=[...Array.from({length:9},(_,i)=>job(i)),job(9,{eligibility:'INELIGIBLE'}),job(0)];
  const membership=selectTodayMembership(data(jobs));
  assert.equal(membership.members.length,9);assert.equal(new Set(membership.memberJobIds).size,9);
  assert.equal(membership.diagnostics.trace.find(x=>x.jobId==='job-9').exactRule,'HARD_STOP_INELIGIBLE');
});

test('DO_NOT_APPLY remains Human-governed only when an unresolved review exists',()=>{
  const jobs=[job(0,{recommendation:'DO_NOT_APPLY'}),job(1,{recommendation:'DO_NOT_APPLY'})];
  const input=data(jobs,[state('job-1','human_decision','NEXT_STAGE')],{enrichmentRequests:[{jobId:'job-1',status:'READY_FOR_REVIEW'}]});
  const membership=selectTodayMembership(input);
  assert.deepEqual(membership.memberJobIds,['job-1']);assert.equal(membership.members[0].admissionReason,'HUMAN_ACTION');
  assert.equal(membership.diagnostics.trace.find(x=>x.jobId==='job-0').exactRule,'MACHINE_DO_NOT_APPLY_WITHOUT_UNRESOLVED_HUMAN_WORK');
});

test('Supabase-like cancelled history synthesizes reauthorization as the one current instruction',()=>{
  const human=projectHumanState({humanDecision:'NEXT_STAGE',applicationDecision:'HOLD',enrichment:{status:'READY_FOR_REVIEW'},execution:{status:'CANCELLED'},readiness:{ready:true},attentionType:'APPROVAL_REQUIRED'});
  assert.deepEqual({status:human.status,action:human.action,humanAttention:human.humanAttention,contradiction:human.contradiction},{status:'WAITING_FOR_YOU',action:'Authorize new attempt',humanAttention:true,contradiction:null});
});

test('true hold and impossible competing action have safe distinct projections',()=>{
  const held=projectHumanState({humanDecision:'HOLD'});assert.equal(held.status,'ON_HOLD');assert.equal(held.humanAttention,false);
  const conflict=projectHumanState({humanDecision:'HOLD',attentionType:'REVIEW_REQUIRED'});assert.equal(conflict.status,'BLOCKED');assert.equal(conflict.humanAttention,false);assert.equal(conflict.contradiction.code,'TODAY_STATE_CONTRADICTION');
});

test('NEXT_STAGE dispatch is deterministic by workflow state',()=>{
  const pending=selectTodayMembership(data([job(0)],[state('job-0','human_decision','NEXT_STAGE')],{enrichmentRequests:[{jobId:'job-0',status:'PENDING'}]}));
  assert.equal(pending.members[0].admissionReason,'PINNED');assert.equal(pending.members[0].admissionDetail,'GOVERNED_WORKFLOW_ACTIVE');
  const review=selectTodayMembership(data([job(0,{recommendation:'DO_NOT_APPLY'})],[state('job-0','human_decision','NEXT_STAGE')],{enrichmentRequests:[{jobId:'job-0',status:'READY_FOR_REVIEW'}]}));
  assert.equal(review.members[0].admissionReason,'HUMAN_ACTION');assert.equal(review.members[0].admissionDetail,'EVALUATION_OR_PACKAGE_REVIEW_REQUIRED');
});

test('under-target missing required priority is BLOCKED rather than EXHAUSTED',()=>{
  const candidate=job(0);delete candidate.assessment.finalPriorityScore;
  const input=data([candidate]);delete input.candidateSelection.snapshot[0].finalPriorityScore;
  const membership=selectTodayMembership(input);
  assert.equal(membership.outcome,'BLOCKED');assert.equal(membership.members.length,0);assert.deepEqual(membership.diagnostics.blockedCandidates,['job-0']);
  assert.ok(detectOperationalSignals({today:membership.diagnostics}).some(x=>x.signalType==='TODAY_REFILL_BLOCKED'));
});

test('attention count is canonical and independent from row count after refill',()=>{
  const input=data([job(0),job(1)],[state('job-0','human_decision','HOLD')]);
  const projection=buildControlPlaneProjection(input),attention=projection.tabs.SETTINGS.find(x=>x.Key==='Needs Your Attention').Value;
  assert.equal(projection.tabs.TODAY.length,2);assert.equal(attention,1);
});

test('refill reorder preserves Human-owned values by canonical Entity ID',()=>{
  const projected=[{'Entity ID':'job-b','Human Answer':'','Human Decision':'NO_ACTION',Rank:1},{'Entity ID':'job-a','Human Answer':'','Human Decision':'NO_ACTION',Rank:2}];
  const existing=[{'Entity ID':'job-a','Human Answer':'unsynced answer','Human Decision':'NEXT_STAGE',Rank:1},{'Entity ID':'job-b','Human Answer':'','Human Decision':'NO_ACTION',Rank:2}];
  const merged=mergeProjectionRows('TODAY',projected,existing);
  assert.equal(merged.find(x=>x['Entity ID']==='job-a')['Human Answer'],'unsynced answer');assert.equal(merged.find(x=>x['Entity ID']==='job-a')['Human Decision'],'NEXT_STAGE');
});

test('same Registry state produces an identical idempotent projection and contiguous physical rank',()=>{
  const input=data(Array.from({length:10},(_,i)=>job(i))),a=buildControlPlaneProjection(input),b=buildControlPlaneProjection(input);
  assert.equal(a.hash,b.hash);assert.deepEqual(a.tabs.TODAY.map(x=>x.Rank),Array.from({length:10},(_,i)=>i+1));
});

test('TODAY operational signals ignore legitimate exhaustion and detect contradictions',()=>{
  assert.equal(detectOperationalSignals({today:{target:10,currentCount:9,outcome:'EXHAUSTED',admissibleRemainder:0,stateContradictions:[]}}).some(x=>x.signalType.startsWith('TODAY_')),false);
  const signals=detectOperationalSignals({today:{target:10,currentCount:9,outcome:'EXHAUSTED',admissibleRemainder:0,stateContradictions:[{jobId:'job-x'}]}});
  assert.ok(signals.some(x=>x.signalType==='TODAY_STATE_CONTRADICTION'));
});
