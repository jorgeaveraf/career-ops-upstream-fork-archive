import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTodayMembership } from '../human-control-plane/today-membership.mjs';
import { deriveHumanAttentionItems } from '../human-attention/service.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';
import { DailyCompletionSummaryService } from '../notifications/daily-completion.mjs';
import { NotificationDeliveryWorker } from '../notifications/outbox.mjs';

const NOW='2026-08-29T23:00:00.000Z';
const makeData=()=>{
  const jobs=Array.from({length:16},(_,index)=>({
    job:{id:`job-${index}`,company:`Company ${index}`,title:`Role ${index}`,location:'Remote — Mexico',url:`https://example.test/${index}`,lastSeenAt:NOW},
    assessment:{eligibilityStatus:'ELIGIBLE',decision:'SHORTLIST',finalPriorityScore:100-index,result:{candidateFit:{score:90-index,reasons:['Relevant role']}}},
    evaluation:index===14?null:{recommendation:index===13?'DO_NOT_APPLY':'APPLY',confidence:index===13?'LOW':'HIGH',gaps:index===13?['Material pursuit risk']:[]},
  }));
  const snapshot=jobs.map((value,index)=>({jobId:value.job.id,rank:index+1,eligibilityStatus:'ELIGIBLE',decision:'SHORTLIST',finalPriorityScore:100-index}));
  return{jobs,humanState:[{entityType:'JOB',entityId:'job-13',field:'human_decision',value:'NEXT_STAGE'},{entityType:'JOB',entityId:'job-15',field:'human_decision',value:'HOLD'}],candidateSelection:{snapshot,top10:snapshot.slice(0,10),activeCandidates:snapshot.map(value=>({jobId:value.jobId,state:'ACTIVE'})),researchNeeds:[]},enrichmentRequests:[],applicationExecutions:[],contacts:[],contactResearch:[],communities:[],workflowStatuses:[],communityWorkflowStatuses:[]};
};

test('TodayMembershipPolicy admits APPLY only and every pin/hold consumes total capacity',()=>{
  const data=makeData(),membership=selectTodayMembership(data,{capacity:10});
  assert.equal(membership.members.length,10);
  assert.equal(membership.curated.length,8);
  assert.equal(membership.pinnedJobIds.includes('job-13'),true);
  assert.equal(membership.held.some(value=>value.jobId==='job-15'),true);
  assert.equal(membership.curatedJobIds.includes('job-14'),false);
  assert.equal(membership.curatedJobIds.includes('job-13'),false);
  assert.equal(membership.outcome,'FILLED');
});

test('curated capacity refills deterministically after an applied item leaves',()=>{
  const data=makeData(),before=selectTodayMembership(data,{capacity:10});
  const leaving=before.curatedJobIds[0];data.applicationExecutions=[{jobId:leaving,status:'APPLIED'}];
  const after=selectTodayMembership(data,{capacity:10});
  assert.equal(after.members.length,10);
  assert.equal(after.memberJobIds.includes(leaving),false);
  assert.equal(after.memberJobIds.includes('job-8'),true);
});

test('negative evaluation review is low priority and cannot approve without a package',()=>{
  const data=makeData();data.jobs.find(value=>value.job.id==='job-13').evaluation.status='VALID';data.enrichmentRequests=[{jobId:'job-13',status:'READY_FOR_REVIEW',updatedAt:NOW,applicationPlan:{status:'READY',primaryPath:'ATS'},packageState:{},artifactManifest:{resumeStatus:'NOT_NEEDED',coverLetterStatus:'NOT_NEEDED'},enrichmentCompletion:{jobResearch:'COMPLETE',companyResearch:'COMPLETE',hiringResearch:'COMPLETE_NONE_VERIFIED',contactResearch:'NOT_RUN',applicationPathResearch:'COMPLETE',evidenceCount:3,sourceCount:2,sources:['a','b'],lastEnriched:NOW}}];
  const item=deriveHumanAttentionItems(data).find(value=>value.jobId==='job-13');
  assert.equal(item.priority,'LOW');
  assert.deepEqual(item.allowedActions,['REJECT','HOLD','NEXT_STAGE']);
  assert.equal(item.allowedActions.includes('APPROVE_TO_APPLY'),false);
});

test('TODAY physical ordering is identical to visible sequential rank',()=>{
  const projection=buildControlPlaneProjection(makeData()),rows=projection.tabs.TODAY;
  assert.deepEqual(rows.map(row=>row.Rank),rows.map((_,index)=>index+1));
  assert.equal(rows.some(row=>row['Entity ID']==='job-14'),false);
  assert.equal(rows.find(row=>row['Entity ID']==='job-13').Recommendation.startsWith('DO_NOT_APPLY'),true);
});

test('successful daily delivery persists canonical run completion for Sheet projection',async()=>{
  const env={CAREER_OPS_NOTIFICATIONS_ENABLED:'true',CAREER_OPS_NOTIFICATION_RECIPIENT:'operator@example.test',CAREER_OPS_DAILY_COMPLETION_SUMMARY:'true'};
  const registry=new JobRegistry({dbPath:':memory:',clock:()=>new Date(NOW),env});
  try{registry.startOperationalRun({id:'daily-v41',startedAt:NOW});registry.finishOperationalRun('daily-v41',{status:'SUCCESS',finishedAt:NOW,discoveryRunId:'discovery-v41'});new DailyCompletionSummaryService({registry,clock:()=>new Date(NOW)}).enqueueForLatestCompletedRun();const worker=new NotificationDeliveryWorker({outbox:registry.notificationOutbox,provider:{sendSummary:async()=>({id:'sent-v41'})},clock:()=>new Date(NOW),env});assert.equal((await worker.processOne()).status,'SENT');assert.equal(registry.getOperationalRun('daily-v41').notificationSent,true);const projection=buildControlPlaneProjection(registry.getControlPlaneData({candidateScope:'decision'}));assert.notEqual(projection.tabs.SETTINGS.find(row=>row.Key==='Last Daily Summary').Value,'NONE');}finally{registry.close();}
});
