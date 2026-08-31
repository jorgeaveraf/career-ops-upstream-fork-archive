import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { validateApplicationReadiness } from '../application-enrichment/readiness.mjs';
import { projectHumanState, HUMAN_STAGES, HUMAN_STATUSES } from '../human-control-plane/human-state.mjs';
import { buildApplicationResearchPlan } from '../application-enrichment/planner.mjs';
import { ContactDiscoveryProvider } from '../contact-intelligence/contracts.mjs';
import { ContactIntelligenceEngine } from '../contact-intelligence/engine.mjs';
import { extractFacebookPost } from '../facebook/extraction.mjs';
import { runFacebookMonitoring } from '../facebook.mjs';
import { JobRegistry } from '../registry/job-registry.mjs';

const NOW='2026-08-29T12:00:00.000Z';
const source=(hash,url='https://www.linkedin.com/in/jane-doe')=>({providerId:'fixture',providerVersion:'2',sourceType:'PUBLIC_PROFILE',sourceUrl:url,sourceHash:hash,retrievedAt:NOW});
const evidence=(field,value,confidence='HIGH',hash=field,url)=>({field,value,confidence,extractionMethod:'DIRECT',source:source(hash,url)});
const validInput=(overrides={})=>({evaluation:{status:'VALID',recommendation:'APPLY'},applicationPlan:{status:'READY',primaryPath:'ATS'},applicationPackage:{id:'p1',packageVersion:1,validationStatus:'VALID'},latestApplicationPackage:{id:'p1',packageVersion:1,validationStatus:'VALID'},artifactManifest:{packageVersion:1,resumeStatus:'READY',coverLetterStatus:'NOT_NEEDED'},completion:{evidenceCount:2,contactResearch:'COMPLETE_NONE_VERIFIED'},packageState:'DRAFT',...overrides});

test('V4 readiness enforces required artifacts, current package, path, evidence, and completed contacts',()=>{
  assert.equal(validateApplicationReadiness(validInput()).ready,true);
  assert.deepEqual(validateApplicationReadiness(validInput({artifactManifest:{packageVersion:1,resumeStatus:'NOT_GENERATED',coverLetterStatus:'NOT_NEEDED'}})).failures.map(x=>x.code),['RESUME_NOT_GENERATED']);
  assert.equal(validateApplicationReadiness(validInput({artifactManifest:{packageVersion:1,resumeStatus:'READY',coverLetterStatus:'NOT_GENERATED'}})).ready,false);
  assert.equal(validateApplicationReadiness(validInput({latestApplicationPackage:{id:'p2',packageVersion:2,validationStatus:'VALID'}})).failures[0].code,'PACKAGE_SUPERSEDED');
  assert.equal(validateApplicationReadiness(validInput({completion:{evidenceCount:2,contactResearch:'NOT_RUN'}})).failures[0].code,'CONTACT_RESEARCH_INCOMPLETE');
  assert.equal(validateApplicationReadiness(validInput({completion:{evidenceCount:2,contactResearch:'BLOCKED'}})).ready,true);
});

test('cover letter NOT_NEEDED is valid while a required cover letter is not',()=>{
  assert.equal(validateApplicationReadiness(validInput()).ready,true);
  const missing=validInput({artifactManifest:{packageVersion:1,resumeStatus:'READY',coverLetterStatus:'NOT_GENERATED'}});
  assert.equal(validateApplicationReadiness(missing).ready,false);
});

test('human projection hides technical lifecycle behind deterministic stages and statuses',()=>{
  assert.deepEqual(HUMAN_STAGES,['DISCOVERED','PREPARING','READY']);assert.deepEqual(HUMAN_STATUSES,['WAITING_FOR_YOU','WORKING','QUEUED','READY','BLOCKED','ON_HOLD']);
  assert.deepEqual(projectHumanState({}),{stage:'DISCOVERED',status:'WAITING_FOR_YOU',action:'Decide',inToday:true});
  assert.equal(projectHumanState({humanDecision:'NEXT_STAGE',enrichment:{status:'PENDING'}}).status,'QUEUED');
  assert.equal(projectHumanState({humanDecision:'NEXT_STAGE',enrichment:{status:'EVALUATING'}}).status,'WORKING');
  assert.deepEqual(projectHumanState({enrichment:{status:'READY_FOR_REVIEW'},readiness:{ready:true,recommendation:'APPLY'},attentionType:'REVIEW_REQUIRED'}),{stage:'READY',status:'WAITING_FOR_YOU',action:'Review package',inToday:true});
  assert.equal(projectHumanState({execution:{status:'APPLIED'}}).inToday,false);
});

test('Contact Intelligence ranks a direct recruiter first and never invents email',async()=>{
  class Provider extends ContactDiscoveryProvider{constructor(){super({id:'fixture',version:'2'});}async findCompany(){return{company:{name:'Acme',domain:'acme.example'},evidence:[evidence('name','Acme','HIGH','company','https://acme.example/team'),evidence('domain','acme.example','HIGH','domain','https://acme.example/team')]};}async findPeople(){return[
    {ref:'leader',name:'Lee Lead',role:'Head of Engineering',profileUrl:'https://www.linkedin.com/in/lee-lead',evidence:[evidence('name','Lee Lead'),evidence('company','Acme'),evidence('role','Head of Engineering'),evidence('profile_url','https://www.linkedin.com/in/lee-lead')]},
    {ref:'recruiter',name:'Jane Doe',role:'Technical Recruiter',profileUrl:'https://www.linkedin.com/in/jane-doe',evidence:[evidence('name','Jane Doe'),evidence('company','Acme'),evidence('role','Technical Recruiter'),evidence('profile_url','https://www.linkedin.com/in/jane-doe')]},
  ];}async findRelationships(){return[];}async getSearchReport(){return{completed:true,bounded:true,sourcesSearched:[{status:'SUCCESS'}],queriesAttempted:5,pagesInspected:5};}}
  const artifact=await new ContactIntelligenceEngine({provider:new Provider(),clock:()=>new Date(NOW)}).research({job:{id:'j1',company:'Acme'}});
  assert.equal(artifact.completionStatus,'COMPLETE_WITH_CONTACT');assert.equal(artifact.primaryContact.name,'Jane Doe');assert.equal(artifact.primaryContact.contactType,'RECRUITER');assert.equal(artifact.primaryContact.publicEmail,'');assert.match(artifact.primaryContact.publicProfileUrl,/linkedin\.com/);assert.equal(artifact.contacts.length,2);
});

test('NONE_VERIFIED requires a completed bounded contact search',async()=>{
  class Empty extends ContactDiscoveryProvider{constructor(completed){super({id:'empty'});this.completed=completed;}async findCompany(){return{company:{name:'Acme'},evidence:[evidence('name','Acme','HIGH','acme','https://acme.example')]};}async findPeople(){return[];}async findRelationships(){return[];}async getSearchReport(){return{completed:this.completed,bounded:true,sourcesSearched:[],queriesAttempted:0,pagesInspected:0};}}
  const complete=await new ContactIntelligenceEngine({provider:new Empty(true),clock:()=>new Date(NOW)}).research({job:{id:'j1',company:'Acme'}});assert.equal(complete.resultStatus,'NONE_VERIFIED');
  const incomplete=await new ContactIntelligenceEngine({provider:new Empty(false),clock:()=>new Date(NOW)}).research({job:{id:'j2',company:'Acme'}});assert.equal(incomplete.completionStatus,'NOT_RUN');assert.notEqual(incomplete.resultStatus,'NONE_VERIFIED');
});

test('contact research plan is role-adaptive and bounded',()=>{const plan=buildApplicationResearchPlan({request:{id:'r',jobId:'j'},job:{id:'j',company:'Acme',title:'Solutions Engineer',url:'https://acme.example/jobs/1'},observation:{description:'x'.repeat(600)}});const queries=plan.tasks.filter(x=>x.id.startsWith('contact-search')).map(x=>x.query);assert.equal(queries.length,5);assert.ok(queries.some(x=>/solutions engineering/.test(x)));assert.equal(plan.budget.maxSearchQueries,6);assert.equal(plan.budget.maxPages,8);assert.equal(plan.budget.maxBrowserMinutes,12);});

test('Facebook extraction uses V4 taxonomy and preserves explicit opportunity facts',()=>{const post=extractFacebookPost({url:'https://facebook.com/groups/1/posts/2/',externalId:'2',author:'Public Recruiter',postedAt:NOW,text:'Freelance project opportunity at Acme Labs. Remote LATAM. USD 5000. Responsibilities include Python data systems.',links:['https://acme.example/jobs/2']},{communityId:'c1',runId:'r1',retrievedAt:NOW});assert.equal(post.opportunityType,'FREELANCE');assert.equal(post.remoteStatus,'REMOTE');assert.equal(post.employmentType,'FREELANCE');assert.equal(post.compensation,'USD 5000');assert.equal(post.companyIdentityStatus,'CONFIRMED');});

test('daily Facebook monitoring performs zero social mutations',async()=>{const registry=new JobRegistry({dbPath:':memory:',clock:()=>new Date(NOW)});try{const result=await runFacebookMonitoring({registry,ranking:false});assert.deepEqual(result.mutations,{joins:0,comments:0,dms:0,posts:0});assert.equal(result.groups,0);const source=readFileSync(new URL('../facebook/monitor.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/\.join\(|\.comment\(|\.sendMessage\(|\.post\(/);}finally{registry.close();}});
