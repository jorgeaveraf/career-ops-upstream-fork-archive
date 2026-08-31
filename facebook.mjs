#!/usr/bin/env node
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { flagValue } from './lib/cli-flags.mjs';
import { openCandidateKnowledge } from './candidate-knowledge/provider.mjs';
import { createDiscoveryStrategy } from './discovery-strategy/engine.mjs';
import { openJobRegistry, DEFAULT_REGISTRY_PATH } from './registry/job-registry.mjs';
import { BrowserSessionManager, browserSelectionFromEnv } from './research/browser-session-manager.mjs';
import { ManagedBrowserSession, managedBrowserSessionConfigFromEnv } from './research/managed-browser-session.mjs';
import { MacOsChromeWindowDriver } from './research/macos-chrome-window-driver.mjs';
import { ManagedChromeResearchAdapter } from './research/playwright-read-only-adapter.mjs';
import { FacebookReadOnlyBrowserAdapter } from './facebook/browser-adapter.mjs';
import { FacebookAuthorizedJoinBrowserAdapter } from './facebook/join-browser-adapter.mjs';
import { FacebookCommunitySyncService } from './facebook/community-sync.mjs';
import { FacebookMembershipVerifier } from './facebook/membership-verifier.mjs';
import { FacebookMembershipReconciliationService } from './facebook/membership-reconciliation.mjs';
import { buildFacebookCommunityTasks, FacebookCommunityDiscoveryProvider } from './facebook/discovery.mjs';
import { FacebookGroupMonitor } from './facebook/monitor.mjs';
import { FACEBOOK_CAPABILITIES, FACEBOOK_DISCOVERY_BUDGET, FACEBOOK_MONITOR_BUDGET } from './facebook/contracts.mjs';
import { GoogleSheetsApiAdapter } from './human-control-plane/sheets-adapter.mjs';
import { HumanControlPlaneSync } from './human-control-plane/sync.mjs';
import { buildControlPlaneProjection } from './human-control-plane/projection.mjs';
import { createGoogleOAuthTokenProviderFromEnv } from './operations/google-oauth.mjs';
import { commandPayloadHash, deterministicLegacyCommandId } from './operations/command-contract.mjs';

export function buildFacebookDryRun({ strategy, metadata, maxQueries = FACEBOOK_DISCOVERY_BUDGET.maxQueries } = {}) {
  return { status: 'DRY_RUN', mode: 'research_only', capabilities: FACEBOOK_CAPABILITIES,
    candidateKbHash: metadata.hash, strategyRevision: strategy.revision,
    tasks: buildFacebookCommunityTasks(strategy, { maxQueries }), navigationStarted: false, writes: [],
    prohibitedActions: ['join','request_to_join','message','react','comment','apply','submit','upload'] };
}
function usage(){console.log(`Usage:
  npm run facebook -- discover-communities --dry-run [--max-queries 5]
  npm run facebook -- discover-communities [--max-queries 10] [--max-candidates 30]
  npm run facebook -- communities
  npm run facebook -- sync-communities [--require-request]
  npm run facebook -- execute-authorized-joins
  npm run facebook -- reconcile-memberships [--sync-sheet]
  npm run facebook -- monitor [--group community-id]

Discovery and monitoring are read-only. sync-communities may click Join once only for an exact persisted WANT_TO_JOIN authorization; it never answers questions, accepts rules, messages, reacts, comments, applies, submits, or uploads.`);}
const boundedInt=(value,{fallback,min,max,name})=>{const number=Number(value??fallback);if(!Number.isInteger(number)||number<min||number>max)throw new Error(`${name} must be an integer from ${min} to ${max}`);return number;};

async function withFacebookBrowser(work){
  const lockManager=new BrowserSessionManager({lockPath:process.env.BROWSER_SESSION_LOCK||process.env.BROWSER_RESEARCH_LOCK||path.join('data','browser','.careerops-session.lock')});
  const managedSession=new ManagedBrowserSession({lockManager,windowDriver:new MacOsChromeWindowDriver(),...managedBrowserSessionConfigFromEnv()});
  let session;const adapter=new ManagedChromeResearchAdapter();
  try{session=await managedSession.acquire(browserSelectionFromEnv());await adapter.start(session);return await work(new FacebookReadOnlyBrowserAdapter({managedAdapter:adapter}));}
  finally{try{await adapter.close();}catch{}if(session)await managedSession.release(session);}
}

export async function runFacebookMonitoring({registry,browser=null,budget=FACEBOOK_MONITOR_BUDGET,clock=()=>new Date(),ranking=true}={}){
  if(!registry)throw new TypeError('registry is required');const runId=`facebook-group-monitor-${randomUUID()}`;registry.startRun({id:runId,type:'facebook_group_monitoring',metadata:{dailyBrowserResearch:true,mutations:{joins:0,comments:0,dms:0,posts:0}}});
  try{const joined=registry.listFacebookCommunities().filter(item=>!item.suppressedAt&&item.membershipState==='JOINED_CONFIRMED').slice(0,budget.maxGroups);const result=joined.length?await (browser?new FacebookGroupMonitor({registry,browser,clock}).monitor({runId,budget}):withFacebookBrowser(adapter=>new FacebookGroupMonitor({registry,browser:adapter,clock}).monitor({runId,budget}))):{status:'SUCCESS',groups:0,results:[],postsInspected:0,recentUniquePosts:0,classifications:{JOB:0,CONTRACT:0,FREELANCE:0,HIRING_SIGNAL:0,NOT_OPPORTUNITY:0,UNKNOWN:0},opportunities:0,authenticityPassed:0,acquisitionObservations:0,newJobs:0,candidatesAccepted:0,observationJobIds:[]};registry.finishRun(runId,{status:result.status,metadata:{dailyBrowserResearch:true,mutations:{joins:0,comments:0,dms:0,posts:0}}});let rankingResult=null;if(ranking&&result.acquisitionObservations){const{rankOperationalCandidates}=await import('./automation/operational-loop.mjs');rankingResult=await rankOperationalCandidates({registry,discoveryRunId:runId,clock});}return{...result,runId,ranking:rankingResult,mutations:{joins:0,comments:0,dms:0,posts:0}};}catch(error){registry.failRun(runId,error);throw error;}
}

async function withAuthorizedJoinBrowser(work){
  const lockManager=new BrowserSessionManager({lockPath:process.env.BROWSER_SESSION_LOCK||process.env.BROWSER_RESEARCH_LOCK||path.join('data','browser','.careerops-session.lock')});
  const managedSession=new ManagedBrowserSession({lockManager,windowDriver:new MacOsChromeWindowDriver(),...managedBrowserSessionConfigFromEnv()});
  let session;const adapter=new ManagedChromeResearchAdapter();
  try{session=await managedSession.acquire(browserSelectionFromEnv());await adapter.start(session);return await work(new FacebookAuthorizedJoinBrowserAdapter({managedAdapter:adapter}));}
  finally{try{await adapter.close();}catch{}if(session)await managedSession.release(session);}
}

async function withMembershipVerifierBrowser(work){
  const lockManager=new BrowserSessionManager({lockPath:process.env.BROWSER_SESSION_LOCK||process.env.BROWSER_RESEARCH_LOCK||path.join('data','browser','.careerops-session.lock')});
  const managedSession=new ManagedBrowserSession({lockManager,windowDriver:new MacOsChromeWindowDriver(),...managedBrowserSessionConfigFromEnv()});
  let session;const adapter=new ManagedChromeResearchAdapter();
  try{session=await managedSession.acquire(browserSelectionFromEnv());await adapter.start(session);return await work(new FacebookMembershipVerifier({managedAdapter:adapter}));}
  finally{try{await adapter.close();}catch{}if(session)await managedSession.release(session);}
}

const settingValue=(matrix,key)=>{const headers=matrix?.[0]||[];const keyIndex=headers.indexOf('Key'),valueIndex=headers.indexOf('Value');if(keyIndex<0||valueIndex<0)return'';return String((matrix.slice(1).find(row=>row[keyIndex]===key)||[])[valueIndex]||'').trim();};

export async function runFacebookCommunitySync({registry:suppliedRegistry=null,dbPath=process.env.CAREER_OPS_DB||DEFAULT_REGISTRY_PATH,spreadsheetId=process.env.CAREER_OPS_SHEET_ID,requireRequest=false,user=process.env.USER||'sheet-user',project=true}={}){
  if(!spreadsheetId)throw new Error('missing CAREER_OPS_SHEET_ID');
  const registry=suppliedRegistry||openJobRegistry({dbPath});const ownsRegistry=!suppliedRegistry;const adapter=new GoogleSheetsApiAdapter({spreadsheetId,tokenProvider:createGoogleOAuthTokenProviderFromEnv()});
  let legacyCommandId=null;
  try{
    if(requireRequest){const requestedAt=settingValue(await adapter.readTab('SETTINGS'),'Community Sync Requested At');if(!requestedAt)return{status:'SKIPPED',reason:'no_community_sync_request',authorized:0,clicked:0,outcomes:{}};legacyCommandId=deterministicLegacyCommandId(`communities.sync:${spreadsheetId}:${requestedAt}`);const envelope={command_version:'3A.1',command_id:legacyCommandId,command_type:'communities.sync',requested_at:requestedAt,source:'google_sheet_legacy_polling',sheet_id:spreadsheetId,requested_by:user,correlation_id:legacyCommandId,payload:{legacy_transport:true}};const received=registry.receiveWorkflowCommand({envelope,payloadHash:commandPayloadHash(envelope)});if(received.duplicate&&!['RECEIVED','PROCESSING'].includes(received.command.status))return{status:'SKIPPED',reason:'request_already_processed',commandId:legacyCommandId,authorized:0,clicked:0,outcomes:{}};registry.claimWorkflowCommand(legacyCommandId);}
    const metadata=openCandidateKnowledge({projectRoot:process.cwd()}).getMetadata();const careerOpsVersion=readFileSync('VERSION','utf8').trim().split(/\s+/)[0];
    const makeProjection=()=>buildControlPlaneProjection(registry.getControlPlaneData({spreadsheetId,candidateScope:'decision'}),{spreadsheetId,careerOpsVersion,schemaVersion:registry.getSchemaVersion(),candidateKbVersion:metadata.version});
    const sync=new HumanControlPlaneSync({registry,adapter,spreadsheetId});const pull=await sync.pull(makeProjection(),{user});
    const plan=registry.listFacebookCommunityJoinPlan().filter(item=>!item.community.suppressedAt);
    const joins=plan.length?await withAuthorizedJoinBrowser(browser=>new FacebookCommunitySyncService({registry,browser}).processAuthorizedJoins()):{authorized:0,clicked:0,outcomes:{},results:[]};
    const result={status:'COMPLETED',decisionsImported:pull.imported.applied.length,decisionsRejected:pull.rejected.length,suppressed:registry.listFacebookCommunities().filter(item=>item.suppressedAt).length,...joins};
    if(legacyCommandId)registry.completeWorkflowCommand(legacyCommandId,{status:'SUCCESS',resultSummary:`${result.decisionsImported} decisions processed · ${result.clicked||0} join clicks`});
    const push=project?await sync.push(makeProjection(),{preserveHumanEdits:false}):null;
    return{...result,pushId:push?.id||null,projectionDeferred:!project};
  }catch(error){if(legacyCommandId)registry.completeWorkflowCommand(legacyCommandId,{status:'FAILED',errorCode:error.code||'COMMUNITY_SYNC_FAILED',errorMessage:error.message});throw error;}finally{if(ownsRegistry)registry.close();}
}

export async function runFacebookMembershipReconciliation({dbPath=process.env.CAREER_OPS_DB||DEFAULT_REGISTRY_PATH,spreadsheetId=process.env.CAREER_OPS_SHEET_ID,syncSheet=false}={}){
  const registry=openJobRegistry({dbPath});
  try{
    const reconciliation=await withMembershipVerifierBrowser(verifier=>new FacebookMembershipReconciliationService({registry,verifier}).reconcile());
    let sheet={status:'NOT_REQUESTED'};
    if(syncSheet){if(!spreadsheetId)throw new Error('missing CAREER_OPS_SHEET_ID');const metadata=openCandidateKnowledge({projectRoot:process.cwd()}).getMetadata();const careerOpsVersion=readFileSync('VERSION','utf8').trim().split(/\s+/)[0];const projection=buildControlPlaneProjection(registry.getControlPlaneData({spreadsheetId,candidateScope:'decision'}),{spreadsheetId,careerOpsVersion,schemaVersion:registry.getSchemaVersion(),candidateKbVersion:metadata.version});const adapter=new GoogleSheetsApiAdapter({spreadsheetId,tokenProvider:createGoogleOAuthTokenProviderFromEnv()});const pushed=await new HumanControlPlaneSync({registry,adapter,spreadsheetId}).push(projection);sheet={status:'SYNCED',pushId:pushed.id};}
    return{...reconciliation,sheet};
  }finally{registry.close();}
}

async function main(){
  const args=process.argv.slice(2);const command=args[0];if(!command||['-h','--help'].includes(command)){usage();return;}
  const allowed=new Set(['--dry-run','--json','--require-request','--sync-sheet','--db','--max-queries','--max-candidates','--max-groups','--max-posts','--freshness-days','--group']);
  for(let index=1;index<args.length;index++){const arg=args[index];if(arg.startsWith('--')&&!allowed.has(arg)&&![...allowed].some(flag=>arg.startsWith(`${flag}=`)))throw new Error(`unknown option: ${arg}`);}
  const candidateProvider=openCandidateKnowledge({projectRoot:process.cwd()});const metadata=candidateProvider.getMetadata();const strategy=createDiscoveryStrategy({candidateProvider});
  const maxQueries=boundedInt(flagValue(args,'--max-queries'),{fallback:10,min:1,max:10,name:'--max-queries'});
  if(command==='discover-communities'&&args.includes('--dry-run')){console.log(JSON.stringify(buildFacebookDryRun({strategy,metadata,maxQueries}),null,2));return;}
  if(command==='sync-communities'){console.log(JSON.stringify(await runFacebookCommunitySync({dbPath:flagValue(args,'--db')||process.env.CAREER_OPS_DB||DEFAULT_REGISTRY_PATH,requireRequest:args.includes('--require-request')}),null,2));return;}
  if(command==='reconcile-memberships'){console.log(JSON.stringify(await runFacebookMembershipReconciliation({dbPath:flagValue(args,'--db')||process.env.CAREER_OPS_DB||DEFAULT_REGISTRY_PATH,syncSheet:args.includes('--sync-sheet')}),null,2));return;}
  const registry=openJobRegistry({dbPath:flagValue(args,'--db')||process.env.CAREER_OPS_DB||DEFAULT_REGISTRY_PATH});
  try{
    if(command==='communities'){console.log(JSON.stringify({capabilities:FACEBOOK_CAPABILITIES,communities:registry.listFacebookCommunities()},null,2));return;}
    if(command==='execute-authorized-joins'){console.log(JSON.stringify(await withAuthorizedJoinBrowser(browser=>new FacebookCommunitySyncService({registry,browser}).processAuthorizedJoins()),null,2));return;}
    if(command==='discover-communities'){
      const maxCandidates=boundedInt(flagValue(args,'--max-candidates'),{fallback:30,min:1,max:30,name:'--max-candidates'});const runId=`facebook-community-discovery-${randomUUID()}`;registry.startRun({id:runId,type:'facebook_community_discovery',metadata:{strategyRevision:strategy.revision,candidateKbHash:metadata.hash}});
      try{const result=await withFacebookBrowser(browser=>new FacebookCommunityDiscoveryProvider({browser}).discover({strategy,candidateKbHash:metadata.hash,budget:{maxQueries,maxCandidates}}));const saved=registry.recordFacebookCommunities(result.communities,{runId});registry.finishRun(runId,{status:result.status==='SUCCESS'?'SUCCESS':'PARTIAL',metadata:{...result,communities:undefined,saved:saved.length}});console.log(JSON.stringify({...result,communities:saved},null,2));}
      catch(error){registry.failRun(runId,error);throw error;}return;
    }
    if(command==='monitor'){
      if(args.includes('--dry-run')){const selected=registry.listFacebookCommunities().filter(c=>!c.suppressedAt&&c.membershipState==='JOINED_CONFIRMED').slice(0,FACEBOOK_MONITOR_BUDGET.maxGroups);console.log(JSON.stringify({status:'DRY_RUN',mode:'read_only_monitoring',groups:selected.map(c=>({id:c.id,name:c.name,url:c.canonicalUrl})),budget:FACEBOOK_MONITOR_BUDGET,navigationStarted:false,writes:[],prohibitedActions:['join','leave','like','react','comment','share','message','follow','publish','apply']},null,2));return;}
      const runId=`facebook-group-monitor-${randomUUID()}`;registry.startRun({id:runId,type:'facebook_group_monitoring'});
      const budget={maxGroups:boundedInt(flagValue(args,'--max-groups'),{fallback:FACEBOOK_MONITOR_BUDGET.maxGroups,min:1,max:8,name:'--max-groups'}),maxPosts:boundedInt(flagValue(args,'--max-posts'),{fallback:FACEBOOK_MONITOR_BUDGET.maxPosts,min:1,max:25,name:'--max-posts'}),freshnessDays:boundedInt(flagValue(args,'--freshness-days'),{fallback:FACEBOOK_MONITOR_BUDGET.freshnessDays,min:1,max:90,name:'--freshness-days'})};
      try{const result=await withFacebookBrowser(browser=>new FacebookGroupMonitor({registry,browser}).monitor({runId,communityId:flagValue(args,'--group'),budget}));registry.finishRun(runId,{status:result.status});console.log(JSON.stringify(result,null,2));}
      catch(error){registry.failRun(runId,error);throw error;}return;
    }
    throw new Error(`unknown command: ${command}`);
  }finally{registry.close();}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(`Facebook research failed: ${error.message}`);process.exitCode=1;});
