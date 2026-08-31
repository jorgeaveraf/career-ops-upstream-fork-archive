import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApplicationActivationPlan } from '../application-activation/planner.mjs';
import { OutreachExecutionService } from '../application-activation/service.mjs';
import { buildExecutionPlan } from '../application-execution/planner.mjs';
import { ApplicationExecutionService } from '../application-execution/service.mjs';
import { containsRawUtc, formatHumanTime } from '../human-time/presentation.mjs';

const NOW=new Date('2026-08-29T23:30:00.000Z');
const pkg={id:'pkg-1',packageVersion:2,artifacts:{outreach:[
  {type:'RECRUITER_MESSAGE',subject:'',content:'Hello — I am interested in the AI Platform Engineer role at Example AI. My background includes Python and production AI systems. I would value the appropriate next step.',evidence_refs:['skill.python'],requirement_refs:['req.python']},
  {type:'EMAIL_INTRODUCTION',subject:'AI Platform Engineer — Jorge Vera — Example AI',content:'Hello,\n\nI am writing regarding the AI Platform Engineer position at Example AI. My relevant background includes Python and production AI systems. I would welcome the opportunity to discuss the role.\n\nBest,\nJorge Vera',evidence_refs:['skill.python'],requirement_refs:['req.python']},
]}};
const base={job:{id:'job-1',title:'AI Platform Engineer',company:'Example AI'},evaluation:{id:'eval-1',recommendation:'APPLY'},applicationPath:{status:'READY',primaryPath:'ATS',url:'https://example.test/jobs/1',manualRequirements:[],risks:[]},packageRecord:pkg,companyResearch:{name:'Example AI'},channelCapabilities:{emailOutreachConfigured:false,linkedinExactMessaging:false}};
const source={providerId:'public',sourceType:'PUBLIC_PROFILE',sourceUrl:'https://www.linkedin.com/in/ana-recruiter',retrievedAt:'2026-08-29T20:00:00.000Z'};
const contact=(overrides={})=>({resultType:'PRIMARY_CONTACT',personRef:'person-1',name:'Ana Recruiter',role:'Technical Recruiter',contactType:'RECRUITER',whyRelevant:'Public evidence ties the recruiter to technical hiring.',confidence:'HIGH',publicProfileUrl:'https://www.linkedin.com/in/ana-recruiter',publicEmail:'',source,verifiedAt:source.retrievedAt,...overrides});

test('ApplicationActivationPlanner ranks direct contact, general recruiting, and NONE_VERIFIED conservatively',()=>{
  const direct=buildApplicationActivationPlan({...base,contactIntelligence:{completionStatus:'COMPLETE_WITH_CONTACT',contacts:[contact()] }},{clock:()=>NOW});
  assert.equal(direct.status,'ACTIVATION_READY');assert.equal(direct.outreachStrategy,'OUTREACH_RECOMMENDED');assert.equal(direct.outreachPlan.channel,'LINKEDIN_PROFILE');assert.equal(direct.timing,'IMMEDIATELY_AFTER_APPLICATION');assert.equal(direct.secondaryContact,null);assert.ok(direct.outreachPlan.body.length>=300&&direct.outreachPlan.body.length<=500);assert.deepEqual(direct.outreachPlan.evidenceRefs,['skill.python']);
  const general=buildApplicationActivationPlan({...base,contactIntelligence:{completionStatus:'COMPLETE_WITH_CONTACT',contacts:[contact({personRef:'general',name:'Example Recruiting',role:'General Recruiting',contactType:'GENERAL_RECRUITING',confidence:'HIGH',publicProfileUrl:'',otherPublicRoute:'https://example.test/careers'})]}},{clock:()=>NOW});
  assert.equal(general.outreachStrategy,'MANUAL_OUTREACH_RECOMMENDED');assert.equal(general.outreachPlan.channel,'PLATFORM_MESSAGE');assert.ok(general.outreachPlan.body.length>=300&&general.outreachPlan.body.length<=500);
  const none=buildApplicationActivationPlan({...base,contactIntelligence:{completionStatus:'COMPLETE_NONE_VERIFIED',contacts:[]}},{clock:()=>NOW});
  assert.equal(none.outreachStrategy,'NO_OUTREACH');assert.equal(none.outreachPlan.channel,'NONE');assert.equal(none.primaryContact,null);assert.equal(none.outreachPlan.body,'');
});

test('application execution plan never embeds outreach authorization',()=>{
  const request={id:'request-1',status:'READY_FOR_REVIEW',updatedAt:'2026-08-29T20:00:00.000Z',applicationPlan:{status:'READY',primaryPath:'ATS',url:'https://example.test/jobs/1'},contactPlan:{status:'READY',recommended:true,channel:'LINKEDIN',target:'Ana'},artifactManifest:{files:{'resume.pdf':{path:'/tmp/resume.pdf',hash:'h'}}}};
  const plan=buildExecutionPlan({job:{id:'job-1'},request,packageRecord:{id:'pkg-1',packageVersion:1,validationStatus:'VALID'},evaluation:{status:'VALID',recommendation:'APPLY'},now:NOW});
  assert.equal(plan.secondaryChannel,'NONE');assert.equal(plan.secondaryTarget,'');
  const appRegistry={listEnrichmentRequests:()=>[],getJob:()=>null,getLatestApplicationPackage:()=>null,getLatestJobEvaluation:()=>null};
  assert.equal(new ApplicationExecutionService({registry:appRegistry}).authorizeImportedActions([{field:'outreach_decision',value:'APPROVE_OUTREACH'}]).authorizations.length,0);
});

test('outreach waits for confirmed application, sends once, and fails closed on ambiguity',async()=>{
  const plan={jobId:'job-1',contactId:'person-1',channel:'RECRUITER_EMAIL',timing:'IMMEDIATELY_AFTER_APPLICATION',subject:'Role',body:'Grounded body',evidenceRefs:['skill.python'],version:'4.2',hash:'plan-hash'};
  let confirmed=false,current=null,sends=0;
  const registry={getOutreachAuthorization:()=>({id:'auth-1',jobId:'job-1',status:'APPROVED_OUTREACH',outreachPlan:plan}),getOutreachExecutionByAuthorization:()=>current,listApplicationExecutions:()=>confirmed?[{status:'APPLIED'}]:[],getHumanFieldState:()=>[],beginOutreachExecution:()=>current={id:'exec-1',authorizationId:'auth-1',status:'EXECUTING'},finishOutreachExecution(_id,{status,confirmation={},blocker={}}){return current={...current,status,providerConfirmation:confirmation,blocker};}};
  const service=new OutreachExecutionService({registry,executors:{RECRUITER_EMAIL:{async sendOnce({sender}){sends++;assert.equal(sender,'jorgeaveraf@gmail.com');return{confirmed:true,messageId:'message-1'};}}}});
  assert.equal((await service.execute({authorizationId:'auth-1'})).status,'WAITING_FOR_APPLICATION');assert.equal(sends,0);
  confirmed=true;assert.equal((await service.execute({authorizationId:'auth-1'})).status,'SENT');assert.equal((await service.execute({authorizationId:'auth-1'})).reused,true);assert.equal(sends,1);
  current=null;sends=0;registry.getOutreachAuthorization=()=>({id:'auth-2',jobId:'job-1',status:'APPROVED_OUTREACH',outreachPlan:{...plan,hash:'ambiguous'}});registry.beginOutreachExecution=()=>current={id:'exec-2',authorizationId:'auth-2',status:'EXECUTING'};service.executors.RECRUITER_EMAIL={async sendOnce(){sends++;return{confirmed:false};}};
  assert.equal((await service.execute({authorizationId:'auth-2'})).status,'VERIFICATION_REQUIRED');assert.equal((await service.execute({authorizationId:'auth-2'})).reused,true);assert.equal(sends,1);
});

test('Mexico-local presentation uses IANA rules, relative days, and no raw UTC',()=>{
  assert.equal(formatHumanTime('2026-08-29T23:00:03.953Z',{now:NOW,relative:false}),'29 ago 2026 · 5:00 PM');
  assert.equal(formatHumanTime('2026-08-29T23:00:03.953Z',{now:NOW}),'Hoy · 5:00 PM');
  assert.equal(formatHumanTime('2026-08-28T22:36:00.000Z',{now:NOW}),'Ayer · 4:36 PM');
  assert.equal(formatHumanTime('2021-07-01T18:00:00.000Z',{relative:false}),'1 jul 2021 · 1:00 PM');
  assert.equal(formatHumanTime('2026-07-01T18:00:00.000Z',{relative:false}),'1 jul 2026 · 12:00 PM');
  assert.equal(formatHumanTime('2026-08-30T06:30:00.000Z',{now:new Date('2026-08-30T05:30:00.000Z')}),'30 ago 2026 · 12:30 AM');
  assert.equal(containsRawUtc(formatHumanTime('2026-08-29T23:00:03.953Z',{relative:false})),false);
});
