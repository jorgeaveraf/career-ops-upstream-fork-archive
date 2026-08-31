import test from 'node:test';
import assert from 'node:assert/strict';
import { JobRegistry } from '../registry/job-registry.mjs';
import { ATTENTION_TYPES, VERIFICATION_RESOLUTIONS } from '../human-attention/contracts.mjs';
import { deriveHumanAttentionItems, HumanAttentionService } from '../human-attention/service.mjs';
import { DailyCompletionSummaryService, localDate } from '../notifications/daily-completion.mjs';
import { renderActionableNotification } from '../notifications/templates.mjs';
import { NotificationPolicyEngine } from '../notifications/policy.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';import path from 'path';
import { artifactAccessUrl, startArtifactAccessServer } from '../artifact-access/service.mjs';

const NOW='2026-08-28T23:05:00.000Z';
const job={job:{id:'job-1',company:'Supabase',title:'Solutions Architect',lastSeenAt:NOW}};

function attentionData({execution,top10=[],enrichment,community,humanState=[]}={}){
  return{jobs:[job],humanState,candidateSelection:{top10,snapshot:top10},applicationExecutions:execution?[execution]:[],enrichmentRequests:enrichment?[enrichment]:[],workflowStatuses:[{jobId:'job-1',lastUpdated:NOW}],communities:community?[community]:[],recentWorkflowEvents:[],rejectedHumanActions:[]};
}

test('V3F attention taxonomy is explicit and verification sorts first',()=>{
  assert.deepEqual(ATTENTION_TYPES,['DECISION_REQUIRED','REVIEW_REQUIRED','ANSWER_REQUIRED','APPROVAL_REQUIRED','VERIFICATION_REQUIRED','FOLLOW_UP_REQUIRED','EXTERNAL_ACTION_REQUIRED']);
  const rows=deriveHumanAttentionItems(attentionData({execution:{id:'app-1',jobId:'job-1',status:'NEEDS_HUMAN',blocker:{code:'VERIFICATION_UNKNOWN'},updatedAt:NOW},top10:[{jobId:'job-1',rank:1}]}));
  assert.equal(rows.length,1);assert.equal(rows[0].attentionType,'VERIFICATION_REQUIRED');assert.deepEqual(rows[0].allowedActions,VERIFICATION_RESOLUTIONS);assert.doesNotMatch(rows[0].allowedActions.join(' '),/RETRY/);
});

test('questions and external challenges normalize without exposing credentials',()=>{
  const answer=deriveHumanAttentionItems(attentionData({execution:{id:'a',jobId:'job-1',status:'NEEDS_HUMAN',blocker:{code:'HUMAN_FIELD',question:'Passport Country'},updatedAt:NOW}}))[0];
  assert.equal(answer.attentionType,'ANSWER_REQUIRED');assert.match(answer.recommendedAction,/Nunca pongas contraseñas/);
  const external=deriveHumanAttentionItems(attentionData({execution:{id:'b',jobId:'job-1',status:'NEEDS_HUMAN',blocker:{code:'MFA_REQUIRED'},updatedAt:NOW}}))[0];
  assert.equal(external.attentionType,'EXTERNAL_ACTION_REQUIRED');assert.equal(external.externalActionRequired,true);
});

test('multiple simultaneous questions stay separate and independently identified',()=>{
  const rows=deriveHumanAttentionItems(attentionData({execution:{id:'multi',jobId:'job-1',status:'NEEDS_HUMAN',blocker:{code:'HUMAN_FIELDS',questions:[{questionId:'passport_country',question:'Passport Country'},{questionId:'salary_expectation',question:'Salary expectation'}]},updatedAt:NOW}}));
  assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.questionId).sort(),['passport_country','salary_expectation']);assert.equal(new Set(rows.map(row=>row.attentionId)).size,2);
});

test('verification validation is explicit and KEEP_UNKNOWN never finishes execution',()=>{
  let finished=0,events=0;const registry={listApplicationExecutions:()=>[{id:'app-1',jobId:'job-1',status:'NEEDS_HUMAN',blocker:{code:'VERIFICATION_UNKNOWN'}}],getHumanFieldState:()=>[],now:()=>NOW,_eventCorrelationForJob:()=> 'corr',finishApplicationExecution(){finished++;},recordWorkflowEvent(){events++;},db:{prepare:()=>({run(){}})}};
  const service=new HumanAttentionService({registry,clock:()=>new Date(NOW)});
  assert.equal(service.validateHumanInput({field:'Human Resolution',value:'YES'}).error,'Human Resolution must be CONFIRMED_APPLIED, NOT_APPLIED or KEEP_UNKNOWN.');
  const result=service.resolveImportedAction({id:'act-1',entityType:'JOB',entityId:'job-1',field:'human_resolution',value:'KEEP_UNKNOWN',user:'jorge'});
  assert.equal(result.status,'RETAINED');assert.equal(finished,0);assert.equal(events,1);
});

test('invalid verification input remains visible and human confirmation performs zero submit clicks',()=>{
  const data=attentionData({execution:{id:'app-1',jobId:'job-1',status:'NEEDS_HUMAN',blocker:{code:'VERIFICATION_UNKNOWN'},updatedAt:NOW}});data.rejectedHumanActions=[{tabName:'TODAY',entityId:'job-1',field:'Human Resolution',status:'REJECTED'}];
  assert.equal(deriveHumanAttentionItems(data)[0].inputError,'Human Resolution must be CONFIRMED_APPLIED, NOT_APPLIED or KEEP_UNKNOWN.');
  let patch,closed=0;const registry={listApplicationExecutions:()=>[{id:'app-1',jobId:'job-1',status:'NEEDS_HUMAN',blocker:{code:'VERIFICATION_UNKNOWN'}}],getHumanFieldState:()=>[],now:()=>NOW,_eventCorrelationForJob:()=> 'corr',finishApplicationExecution(_id,value){patch=value;return{status:value.status};},recordWorkflowEvent(){},db:{prepare:()=>({run(){closed++;}})}};
  const result=new HumanAttentionService({registry}).resolveImportedAction({id:'act-2',entityType:'JOB',entityId:'job-1',field:'human_resolution',value:'CONFIRMED_APPLIED',user:'jorge'});
  assert.equal(result.status,'APPLIED');assert.equal(result.externalSubmitClicks,0);assert.equal(patch.stage,'RECONCILIATION');assert.match(patch.confirmation.id,/^human:/);assert.equal(closed,1);
});

test('daily completion summary is durable, Spanish, zero-safe and deduped by Mexico City date',()=>{
  const env={CAREER_OPS_NOTIFICATIONS_ENABLED:'true',CAREER_OPS_NOTIFICATION_RECIPIENT:'jorgeaveraf@gmail.com',CAREER_OPS_EMAIL_PROVIDER:'resend',CAREER_OPS_DAILY_COMPLETION_SUMMARY:'true'};
  const registry=new JobRegistry({dbPath:':memory:',clock:()=>new Date(NOW),env});try{
    registry.startOperationalRun({id:'daily-1',startedAt:NOW});registry.finishOperationalRun('daily-1',{status:'SUCCESS',finishedAt:NOW,discoveryRunId:'daily-1:discovery',summary:{discovery:{observations:0}},jobsFound:0});
    registry.startOperationalRun({id:'technical-validation',startedAt:NOW});registry.finishOperationalRun('technical-validation',{status:'SUCCESS',finishedAt:NOW,summary:{kind:'technical_validation'},jobsFound:999});
    const service=new DailyCompletionSummaryService({registry,clock:()=>new Date(NOW)}),first=service.enqueueForLatestCompletedRun(),second=service.enqueueForLatestCompletedRun();
    assert.equal(localDate(new Date(NOW)),'2026-08-28');assert.equal(first.status,'PENDING');assert.equal(first.runId,'daily-1');assert.equal(second.status,'ALREADY_ENQUEUED');
    const intents=registry.listNotificationIntents({limit:10}).filter(value=>value.notificationType==='DAILY_COMPLETION_SUMMARY');assert.equal(intents.length,1);assert.equal(intents[0].subject,'Career Ops — resumen de búsqueda de hoy');assert.match(intents[0].bodyText,/Nuevas: 0/);
  }finally{registry.close();}
});

test('manual command success stays silent while failure remains actionable',()=>{
  const policy=new NotificationPolicyEngine(),preferences={events:{COMMAND_FAILED:true}};
  assert.equal(policy.evaluate({event:{eventType:'COMMAND_COMPLETED',refs:{}},preferences}).decision,'SUPPRESS');
  assert.equal(policy.evaluate({event:{eventType:'COMMAND_FAILED',refs:{}},domain:{userInitiatedCommand:true},preferences}).notificationType,'COMMAND_FAILED');
});

test('daily template is concise, linked and does not enumerate jobs',()=>{
  const rendered=renderActionableNotification('DAILY_COMPLETION_SUMMARY',{reviewed:12,newJobs:8,passed:5,shortlisted:4,promoted:2,today:10,attention:2,topThree:[],applicationsConfirmed:0,unresolvedFailures:0,limitedSources:1,systemStatus:'HEALTHY',sheetUrl:'https://docs.google.com/spreadsheets/d/sheet/edit'});
  assert.match(rendered.text,/Revisadas: 12/);assert.match(rendered.text,/Promovidas a APPLY: 2/);assert.match(rendered.text,/Abrir TODAY/);assert.doesNotMatch(rendered.text,/Supabase|job-1/);
});

test('artifact access is loopback-only, exact-package-bound and hides filesystem paths',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'career-ops-artifact-')),filePath=path.join(root,'resume.pdf');writeFileSync(filePath,'pdf-fixture');
  const file={path:filePath,sha256:'abc123',humanFilename:'Jorge Vera - Resume.pdf'},request={id:'request-1',jobId:'job-1',status:'READY_FOR_REVIEW',artifactManifest:{files:{'resume.pdf':file}}};
  const registry={listEnrichmentRequests:()=>[request]},server=await startArtifactAccessServer({registry,port:0});try{
    const base=`http://127.0.0.1:${server.address().port}`,url=artifactAccessUrl({baseUrl:base,jobId:'job-1',requestId:'request-1',key:'resume.pdf',file});assert.doesNotMatch(url,/tmp|resume\.pdf/);
    const response=await fetch(url);assert.equal(response.status,200);assert.equal(await response.text(),'pdf-fixture');request.status='CANCELLED';assert.equal((await fetch(url)).status,410);
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});}
});
