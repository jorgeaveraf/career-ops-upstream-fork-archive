import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { openCandidateKnowledge } from '../candidate-knowledge/provider.mjs';
import { createDiscoveryStrategy } from '../discovery-strategy/engine.mjs';
import { openJobRegistry } from '../registry/job-registry.mjs';
import { buildFacebookDryRun } from '../facebook.mjs';
import { FacebookCommunityDiscoveryProvider } from '../facebook/discovery.mjs';
import { FacebookGroupMonitor } from '../facebook/monitor.mjs';
import { extractFacebookPost } from '../facebook/extraction.mjs';
import { FACEBOOK_CAPABILITIES } from '../facebook/contracts.mjs';
import { browserPolicySummary, assertResearchActionAllowed } from '../research/browser-policy.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';
import { BoundedApplicationResearchProvider } from '../application-enrichment/research-provider.mjs';
import { scoreFacebookCommunity } from '../facebook/scoring.mjs';
import { CandidateSelectionEngine } from '../candidate-selection/engine.mjs';
import { createCandidateSelectionPolicy } from '../candidate-selection/policy.mjs';
import { buildReadmeValues } from '../human-control-plane/sheet-ux.mjs';
import { assertExactCommunityJoinAuthorization } from '../facebook/join-policy.mjs';
import { FacebookCommunitySyncService } from '../facebook/community-sync.mjs';
import { FacebookAuthorizedJoinBrowserAdapter } from '../facebook/join-browser-adapter.mjs';

const candidateProvider=openCandidateKnowledge({projectRoot:process.cwd()});
const metadata=candidateProvider.getMetadata();
const strategy=createDiscoveryStrategy({candidateProvider});
const community=(overrides={})=>({id:'facebook-community-1',canonicalUrl:'https://www.facebook.com/groups/123/',name:'AI Automation Jobs LATAM',topic:'AI jobs',visibility:'PRIVATE',membershipState:'JOIN_REQUIRED',memberCount:12000,activityScore:80,opportunityScore:90,spamScore:5,qualityScore:85,recommendation:'RECOMMENDED',publicDescription:'Remote AI automation jobs for LATAM. Python, n8n, data, hiring.',language:'en',geographySignals:['LATAM'],whyItMatters:'Relevant and active',query:'AI automation jobs',queryReason:'candidate fit',queryPriority:'HIGH',strategyRevision:strategy.revision,candidateKbHash:metadata.hash,evidence:[],...overrides});

test('V2C capability and dry-run contracts are explicit and side-effect free',()=>{
  const result=buildFacebookDryRun({strategy,metadata,maxQueries:5});
  assert.equal(FACEBOOK_CAPABILITIES['facebook.join'],'SUPPORTED_WITH_EXACT_HUMAN_AUTHORIZATION');
  assert.equal(FACEBOOK_CAPABILITIES['facebook.messaging'],'UNSUPPORTED');
  assert.equal(result.tasks.length,5);assert.equal(result.navigationStarted,false);assert.deepEqual(result.writes,[]);assert.equal(result.candidateKbHash,metadata.hash);
});

test('browser policy denies every Facebook mutation',()=>{
  for(const action of ['join','request_to_join','message','react','comment','apply','submit','upload'])assert.throws(()=>assertResearchActionAllowed(action),/not allowed/);
  const policy=browserPolicySummary();assert.ok(policy.blocked.includes('request_to_join'));assert.ok(policy.allowed.includes('read'));
});

test('community discovery is bounded, deduplicated, scored, and stops on challenge',async()=>{
  let searches=0;const browser={
    async searchGroups({query}){searches++;return searches===2?{outcome:'CHALLENGE',classification:'CHALLENGE',groups:[]}:{outcome:'SUCCESS_RESULTS',classification:'SEARCH_RESULTS',groups:[{url:'https://facebook.com/groups/123/?ref=share',name:'AI Automation Jobs LATAM'},{url:'https://facebook.com/groups/123/',name:'duplicate'}]};},
    async inspectGroup(item){return{outcome:'SUCCESS_RESULTS',classification:'GROUP_PRIVATE_NOT_MEMBER',group:{...item,name:'AI Automation Jobs LATAM',description:`Highly active remote jobs hiring AI and data engineers in LATAM. Contract freelance projects, salary, compensation, company, apply email, stack and responsibilities. ${strategy.technologies.slice(0,10).join(' ')}`,visibility:'PRIVATE',membershipObserved:false,memberCountText:'12K members',recentActivity:true}};},
  };
  const result=await new FacebookCommunityDiscoveryProvider({browser}).discover({strategy,candidateKbHash:metadata.hash,budget:{maxQueries:5,maxCandidates:20,maxGroupsOpened:20}});
  assert.equal(searches,2);assert.equal(result.status,'PARTIAL');assert.equal(result.communities.length,1);assert.equal(result.communities[0].candidateKbHash,metadata.hash);assert.equal(result.communities[0].membershipState,'JOIN_REQUIRED');assert.equal(result.communities[0].memberCount,12000);
});

test('quality scoring favors concrete opportunities and penalizes large spam groups',()=>{
  const strong=scoreFacebookCommunity({name:'LATAM AI Engineering Jobs',description:'Active hiring jobs contract freelance. Company salary compensation stack responsibilities apply email remote Python data automation n8n GCP.',recentActivity:true},strategy);
  const spam=scoreFacebookCommunity({name:'Huge Remote Group',description:'Affiliate course curso crypto earn money engagement promotion register here '.repeat(8),memberCount:2_000_000,recentActivity:true},strategy);
  assert.ok(strong.qualityScore>spam.qualityScore);assert.equal(spam.recommendation,'REJECTED');
});

test('membership lifecycle is human-controlled and preserves notes',()=>{
  const registry=openJobRegistry({dbPath:':memory:'});try{
    registry.recordFacebookCommunities([community()]);
    registry.recordHumanActions({accepted:[{actionKey:'join-1',spreadsheetId:'sheet',tabName:'COMMUNITIES',entityType:'COMMUNITY',entityId:'facebook-community-1',field:'notes',value:'Useful LATAM group',observedAt:'2026-08-25T12:00:00Z',user:'jorge',sourceHash:'n1'},{actionKey:'join-2',spreadsheetId:'sheet',tabName:'COMMUNITIES',entityType:'COMMUNITY',entityId:'facebook-community-1',field:'membership_decision',value:'JOINED',observedAt:'2026-08-25T12:01:00Z',user:'jorge',sourceHash:'n2'}]});
    assert.equal(registry.getFacebookCommunity('facebook-community-1').membershipState,'JOINED_CONFIRMED');
    assert.ok(registry.getFacebookCommunityEvents('facebook-community-1').some(event=>event.reason==='human_joined'));
    assert.equal(registry.getHumanFieldState().find(x=>x.entityType==='COMMUNITY'&&x.field==='notes').value,'Useful LATAM group');
  }finally{registry.close();}
});

test('WANT_TO_JOIN authorizes one exact click and repeated sync only rechecks',async()=>{
  const registry=openJobRegistry({dbPath:':memory:'});try{
    registry.recordFacebookCommunities([community({membershipState:'DISCOVERED'})]);
    registry.recordHumanActions({accepted:[{actionKey:'want-once',spreadsheetId:'sheet',tabName:'COMMUNITIES',entityType:'COMMUNITY',entityId:'facebook-community-1',field:'membership_decision',value:'WANT_TO_JOIN',observedAt:'2026-08-25T12:00:00Z',user:'jorge',sourceHash:'want'}]});
    const permissions=[];const browser={async inspectAndMaybeJoin({authorization,allowClick}){permissions.push(allowClick);assert.equal(authorization.canonicalUrl,'https://www.facebook.com/groups/123/');return allowClick?{outcome:'JOIN_REQUESTED',clicked:true,reason:'pending',evidence:{}}:{outcome:'JOIN_REQUESTED',clicked:false,reason:'still_pending',evidence:{}};}};
    const service=new FacebookCommunitySyncService({registry,browser});const first=await service.processAuthorizedJoins();const second=await service.processAuthorizedJoins();
    assert.equal(first.clicked,1);assert.equal(second.clicked,0);assert.deepEqual(permissions,[true,false]);assert.equal(registry.getFacebookCommunityJoinExecutions()[0].clickCount,1);assert.equal(registry.getFacebookCommunity('facebook-community-1').membershipState,'JOIN_REQUESTED');
  }finally{registry.close();}
});

test('exact join policy rejects mismatched URLs and suppression survives rediscovery',()=>{
  const registry=openJobRegistry({dbPath:':memory:'});try{
    registry.recordFacebookCommunities([community({membershipState:'DISCOVERED'})]);
    assert.throws(()=>assertExactCommunityJoinAuthorization({community:community(),authorization:{actionId:'a',decision:'WANT_TO_JOIN',url:'https://www.facebook.com/groups/999/'}}),/exact community URL/);
    registry.recordHumanActions({accepted:[{actionKey:'skip-once',spreadsheetId:'sheet',tabName:'COMMUNITIES',entityType:'COMMUNITY',entityId:'facebook-community-1',field:'membership_decision',value:'SKIP',observedAt:'2026-08-25T12:00:00Z',user:'jorge',sourceHash:'skip'}]});
    registry.recordFacebookCommunities([community({membershipState:'RECOMMENDED',qualityScore:99})]);
    const saved=registry.getFacebookCommunity('facebook-community-1');assert.equal(saved.baseMembershipState,'SKIPPED');assert.ok(saved.suppressedAt);assert.equal(buildControlPlaneProjection(registry.getControlPlaneData()).tabs.COMMUNITIES.length,0);
  }finally{registry.close();}
});

test('join browser classifies joined, pending, questions, challenge, and successful public join',async()=>{
  const base={url:'https://www.facebook.com/groups/123/',title:'Group',labels:[],joined:false,pending:false,joinIndex:-1,prompt:false,login:false,challenge:false,body:''};
  const run=async(pages,allowClick=true)=>{let index=0,clicks=0;const managedAdapter={session:{windowId:1},async withOwnedTab(_url,work){return work({domAvailable:true,tabId:2,driver:{async executeJavaScript(_w,_t,script){if(script.includes("el.click()")){clicks++;return'clicked';}return JSON.stringify(pages[Math.min(index++,pages.length-1)]);}}});}};const result=await new FacebookAuthorizedJoinBrowserAdapter({managedAdapter,sleep:async()=>{}}).inspectAndMaybeJoin({authorization:{canonicalUrl:base.url},allowClick});return{...result,clicks};};
  assert.deepEqual((await run([{...base,joined:true}])).outcome,'ALREADY_JOINED');
  assert.deepEqual((await run([{...base,pending:true}])).outcome,'JOIN_REQUESTED');
  assert.deepEqual((await run([{...base,prompt:true}])).outcome,'NEEDS_HUMAN');
  assert.deepEqual((await run([{...base,challenge:true}])).outcome,'CHALLENGE');
  const joined=await run([{...base,joinIndex:0},{...base,joined:true}]);assert.equal(joined.outcome,'JOINED_CONFIRMED');assert.equal(joined.clicks,1);
});

test('already-member observation records JOINED_CONFIRMED without a click',async()=>{
  const registry=openJobRegistry({dbPath:':memory:'});try{registry.recordFacebookCommunities([community({membershipState:'DISCOVERED'})]);registry.recordHumanActions({accepted:[{actionKey:'already',spreadsheetId:'sheet',tabName:'COMMUNITIES',entityType:'COMMUNITY',entityId:'facebook-community-1',field:'membership_decision',value:'WANT_TO_JOIN',observedAt:'2026-08-25T12:00:00Z',user:'jorge',sourceHash:'already'}]});const result=await new FacebookCommunitySyncService({registry,browser:{async inspectAndMaybeJoin(){return{outcome:'ALREADY_JOINED',clicked:false,reason:'visible',evidence:{}};}}}).processAuthorizedJoins();assert.equal(result.clicked,0);assert.equal(registry.getFacebookCommunity('facebook-community-1').membershipState,'JOINED_CONFIRMED');assert.equal(registry.getFacebookCommunityJoinExecutions()[0].outcome,'ALREADY_JOINED');}finally{registry.close();}
});

test('REJECT preserves notes and feedback while soft-deleting only the projection row',()=>{
  const registry=openJobRegistry({dbPath:':memory:'});try{
    registry.recordFacebookCommunities([community()]);registry.recordHumanActions({accepted:[
      {actionKey:'reject-note',spreadsheetId:'sheet',tabName:'COMMUNITIES',entityType:'COMMUNITY',entityId:'facebook-community-1',field:'notes',value:'demasiado general',observedAt:'2026-08-25T12:00:00Z',user:'jorge',sourceHash:'note'},
      {actionKey:'reject-decision',spreadsheetId:'sheet',tabName:'COMMUNITIES',entityType:'COMMUNITY',entityId:'facebook-community-1',field:'membership_decision',value:'REJECT',observedAt:'2026-08-25T12:01:00Z',user:'jorge',sourceHash:'reject'},
    ]});
    const saved=registry.getFacebookCommunity('facebook-community-1');assert.equal(saved.baseMembershipState,'REJECTED');assert.ok(saved.suppressedAt);assert.equal(registry.getHumanFieldState().find(x=>x.entityType==='COMMUNITY'&&x.field==='notes').value,'demasiado general');assert.equal(registry.db.prepare('SELECT notes FROM facebook_community_feedback').get().notes,'demasiado general');assert.equal(buildControlPlaneProjection(registry.getControlPlaneData()).tabs.COMMUNITIES.length,0);
  }finally{registry.close();}
});

test('post extraction classifies opportunity, email provenance, authenticity, and image evidence without OCR',()=>{
  const post=extractFacebookPost({url:'https://facebook.com/groups/123/posts/456/?ref=x',externalId:'456',author:'Public Recruiter',text:'Hiring: Senior AI Systems Engineer at Acme Labs. Responsibilities include production Python data systems. Apply via jobs@acme.example. Salary USD 7000.',links:['https://acme.example/jobs/456'],images:['https://images.example/post.png']},{communityId:'facebook-community-1',runId:'run',retrievedAt:'2026-08-25T12:00:00Z'});
  assert.equal(post.opportunityType,'JOB');assert.equal(post.emails[0].email,'jobs@acme.example');assert.equal(post.companyIdentityStatus,'CONFIRMED');assert.equal(post.imageEvidencePresent,true);assert.equal(post.imageRefs[0].researchNeed,'EXTRACT_IMAGE_EVIDENCE');assert.ok(post.authenticity.score>=45);
});

test('discussion and pool promotion are not accepted as concrete jobs',()=>{
  const discussion=extractFacebookPost({text:'What do you think about this Python course webinar?'},{communityId:'c',runId:'r',retrievedAt:'2026-08-25T12:00:00Z'});
  const pool=extractFacebookPost({text:'Hiring signal: join our talent pool, register here and we match you with multiple opportunities.'},{communityId:'c',runId:'r',retrievedAt:'2026-08-25T12:00:00Z'});
  assert.equal(discussion.opportunityType,'NOT_OPPORTUNITY');assert.equal(pool.opportunityType,'HIRING_SIGNAL');assert.ok(pool.authenticity.score<45);
});

test('joined-only monitor feeds Acquisition once and checkpoints repeat reads',async()=>{
  const registry=openJobRegistry({dbPath:':memory:'});try{
    registry.recordFacebookCommunities([community({membershipState:'JOINED_CONFIRMED'})]);
    let calls=0;const browser={async readRecentPosts(){calls++;const posts=[{url:'https://facebook.com/groups/123/posts/456/',externalId:'456',author:'Recruiter',postedAt:'2026-08-24T12:00:00Z',text:'Hiring: Senior AI Systems Engineer at Acme Labs. You will build production Python data and AI systems. Responsibilities are clear. Apply at jobs@acme.example. Salary USD 7000.',links:['https://acme.example/jobs/456'],images:[]}];if(calls>=3)posts.unshift({...posts[0],url:'https://facebook.com/groups/123/posts/789/',externalId:'789',text:posts[0].text.replace('Acme Labs','Beta Labs').replaceAll('acme','beta')});return{outcome:'SUCCESS_RESULTS',classification:'GROUP_PRIVATE_MEMBER',membershipObserved:true,posts};}};
    registry.startRun({id:'monitor-1',type:'facebook_group_monitoring'});const first=await new FacebookGroupMonitor({registry,browser,clock:()=>new Date('2026-08-25T12:00:00Z')}).monitor({runId:'monitor-1'});registry.finishRun('monitor-1');
    assert.equal(first.candidatesAccepted,1);assert.equal(registry.listFacebookPosts().length,1);assert.equal(registry.getRunSummary('monitor-1').observations,1);assert.equal(registry.getFacebookCommunity('facebook-community-1').membershipState,'JOINED_CONFIRMED');assert.equal(registry.listFacebookCommunityMonitorMetrics('monitor-1').length,1);
    registry.startRun({id:'monitor-2',type:'facebook_group_monitoring'});const second=await new FacebookGroupMonitor({registry,browser,clock:()=>new Date('2026-08-25T13:00:00Z')}).monitor({runId:'monitor-2'});registry.finishRun('monitor-2');assert.equal(second.candidatesAccepted,0);assert.equal(registry.listFacebookPosts().length,1);
    registry.startRun({id:'monitor-3',type:'facebook_group_monitoring'});const third=await new FacebookGroupMonitor({registry,browser,clock:()=>new Date('2026-08-25T14:00:00Z')}).monitor({runId:'monitor-3'});registry.finishRun('monitor-3');assert.equal(third.candidatesAccepted,1);assert.equal(registry.listFacebookPosts().length,2);assert.equal(calls,3);
  }finally{registry.close();}
});

test('monitor refuses unconfirmed membership and stale posts',async()=>{
  const registry=openJobRegistry({dbPath:':memory:'});try{registry.recordFacebookCommunities([community({membershipState:'JOINED_CONFIRMED'})]);registry.startRun({id:'monitor-stale',type:'facebook_group_monitoring'});const monitor=new FacebookGroupMonitor({registry,browser:{async readRecentPosts(){return{outcome:'SUCCESS_RESULTS',membershipObserved:false,posts:[]};}},clock:()=>new Date('2026-08-25T12:00:00Z')});const result=await monitor.monitor({runId:'monitor-stale'});assert.equal(result.results[0].outcome,'MEMBERSHIP_NOT_CONFIRMED');assert.equal(result.candidatesAccepted,0);}finally{registry.close();}
});

test('COMMUNITIES projection exposes only decision and notes as human fields',()=>{
  const registry=openJobRegistry({dbPath:':memory:'});try{registry.recordFacebookCommunities([community()]);const data=registry.getControlPlaneData();const projection=buildControlPlaneProjection(data);assert.equal(projection.tabs.COMMUNITIES.length,1);assert.equal(projection.tabs.COMMUNITIES[0]['Membership Decision'],'NO_ACTION');assert.equal(projection.tabs.COMMUNITIES[0].Community,'AI Automation Jobs LATAM');}finally{registry.close();}
});

test('V2B carries a public Facebook application email as evidence',async()=>{
  const provider=new BoundedApplicationResearchProvider();const result=await provider.research({job:{url:'https://facebook.com/groups/123/posts/456/'},observation:{canonicalUrl:'https://facebook.com/groups/123/posts/456/',description:'Apply by email to jobs@acme.example',lastObservedAt:'2026-08-25T12:00:00Z'},plan:{tasks:[],budget:{maxPages:0,maxBrowserMinutes:0}}});assert.deepEqual(result.evidence.find(x=>x.normalizedField==='application_path').value,{email:'jobs@acme.example'});
});

test('adapter source contains no mutating Facebook operations',()=>{
  const source=readFileSync(new URL('../facebook/browser-adapter.mjs',import.meta.url),'utf8');for(const token of ['click(','fill(','press(','request_to_join','sendMessage','submit('])assert.equal(source.includes(token),false);
});

test('Facebook candidates use normal hard-reject and pool rules',()=>{
  const profile={location:{country:'Mexico'},target_roles:{primary:['AI Systems Engineer'],alternatives:[],seniority:{}},search_preferences:{work_location:{accepted:['Remote'],excluded:['Hybrid','On-site']}},discovery_strategy:{rejection_rules:{companies:['Lemon.io'],pool_signals:{phrases:['talent pool']}}}};
  const portals={max_posting_age_days:30,location_filter:{always_allow:['Worldwide','Mexico'],block:['US']},title_filter:{positive:['AI Systems Engineer'],negative:[]},country_eligibility_filter:{exclusionary:['us only'],inclusive:['mexico','worldwide']},content_filter:{negative:[]}};
  const policy=createCandidateSelectionPolicy(profile,portals);const now='2026-08-25T12:00:00Z';const base={title:'Senior AI Systems Engineer',location:'Remote, Worldwide',description:'Build production AI systems, data platforms and automation services. '.repeat(5),provider:'browser:facebook',sourceUrl:'https://facebook.com/groups/x/posts/y/',postedAt:now,firstObservedAt:now,observedInRun:true,humanState:{}};
  const candidates=['Lemon.io','Micro1','BairesDev','Acme'].map((company,index)=>({...base,jobId:`j${index}`,observationId:`o${index}`,company}));
  const result=new CandidateSelectionEngine({policy,clock:()=>new Date(now)}).select({candidates});
  assert.deepEqual(result.decisions.filter(x=>x.reasons.includes('hard_reject_company')).map(x=>x.jobId).sort(),['j0','j1','j2']);assert.ok(result.activeCandidates.some(x=>x.jobId==='j3'));
});

test('README explains the exact authorized Facebook membership lifecycle',()=>{
  const text=buildReadmeValues().flat().join(' ');for(const phrase of ['COMMUNITIES','WANT_TO_JOIN','JOINED','Sync Communities','preguntas','SKIP/REJECT'])assert.match(text,new RegExp(phrase,'i'));
});
