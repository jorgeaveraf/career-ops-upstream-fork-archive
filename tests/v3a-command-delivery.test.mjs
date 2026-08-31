import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { JobRegistry } from '../registry/job-registry.mjs';
import { commandPayloadHash, validateCommandEnvelope } from '../operations/command-contract.mjs';
import { WorkflowCommandWorker } from '../operations/command-worker.mjs';
import { CommandSubscriber } from '../operations/command-subscriber.mjs';
import { renderCommandSubscriberLaunchAgent } from '../operations/launch-agent.mjs';

const NOW='2026-08-27T20:00:00.000Z';
const envelope=(overrides={})=>({command_version:'3A.1',command_id:randomUUID(),command_type:'jobs.sync',requested_at:NOW,source:'google_sheet',sheet_id:'sheet',requested_by:'user@example.com',correlation_id:randomUUID(),payload:{},...overrides});
const messageFor=body=>{const state={acks:0,nacks:0};return{message:{id:randomUUID(),data:Buffer.from(JSON.stringify(body)),ack(){state.acks++;},nack(){state.nacks++;}},state};};

test('command contract is explicit and rejects arbitrary workflow commands',()=>{assert.equal(validateCommandEnvelope(envelope()).command_type,'jobs.sync');assert.throws(()=>validateCommandEnvelope(envelope({command_type:'run_shell'})),/unsupported command_type/);});
test('registry persists, claims, completes, and deduplicates by command_id',()=>{const registry=new JobRegistry({dbPath:':memory:',clock:()=>new Date(NOW)});try{const body=envelope(),hash=commandPayloadHash(body);assert.equal(registry.receiveWorkflowCommand({envelope:body,payloadHash:hash,pubsubMessageId:'m1'}).duplicate,false);assert.equal(registry.receiveWorkflowCommand({envelope:body,payloadHash:hash,pubsubMessageId:'m2'}).duplicate,true);assert.equal(registry.claimWorkflowCommand(body.command_id).command.status,'PROCESSING');assert.equal(registry.completeWorkflowCommand(body.command_id,{resultSummary:'ok'}).status,'SUCCESS');assert.equal(registry.claimWorkflowCommand(body.command_id).claimed,false);}finally{registry.close();}});
test('subscriber ACKs after durable persistence and executes duplicate once',async()=>{const registry=new JobRegistry({dbPath:':memory:',clock:()=>new Date(NOW)});let executions=0;const worker=new WorkflowCommandWorker({registry,dispatch:async()=>{executions++;return{summary:{rejected:0,held:0,enrichmentQueued:0,executed:0}};},projectStatus:null,logger:{info(){},error(){}}});const subscriber=new CommandSubscriber({registry,subscriptionName:'fixture',projectId:'fixture',pubsub:{},worker,logger:{info(){},error(){}}});try{const body=envelope(),first=messageFor(body),duplicate=messageFor(body);assert.equal((await subscriber.handleMessage(first.message)).status,'SUCCESS');assert.equal(first.state.acks,1);assert.equal((await subscriber.handleMessage(duplicate.message)).status,'IGNORED_DUPLICATE');assert.equal(duplicate.state.acks,1);assert.equal(executions,1);}finally{registry.close();}});
test('a redelivery of a durably RECEIVED command resumes instead of being discarded',async()=>{
  const registry=new JobRegistry({dbPath:':memory:',clock:()=>new Date(NOW)});let executions=0;
  const body=envelope(),hash=commandPayloadHash(body);
  registry.receiveWorkflowCommand({envelope:body,payloadHash:hash,pubsubMessageId:'first-before-crash'});
  const worker=new WorkflowCommandWorker({registry,dispatch:async()=>{executions++;return{summary:{rejected:0,held:0,enrichmentQueued:0,executed:0}};},projectStatus:null,logger:{info(){},error(){}}});
  const subscriber=new CommandSubscriber({registry,subscriptionName:'fixture',projectId:'fixture',pubsub:{},worker,logger:{info(){},error(){}}});
  const redelivery=messageFor(body);assert.equal((await subscriber.handleMessage(redelivery.message)).status,'SUCCESS');
  assert.equal(redelivery.state.acks,1);assert.equal(executions,1);registry.close();
});
test('subscriber nacks invalid data and worker persists failures',async()=>{const registry=new JobRegistry({dbPath:':memory:',clock:()=>new Date(NOW)});const invalid=messageFor({command_type:'run_shell'}),subscriber=new CommandSubscriber({registry,subscriptionName:'fixture',projectId:'fixture',pubsub:{},worker:{process(){throw new Error('unreachable');}},logger:{info(){},error(){}}});assert.equal((await subscriber.handleMessage(invalid.message)).status,'REJECTED');assert.equal(invalid.state.nacks,1);const body=envelope(),hash=commandPayloadHash(body);registry.receiveWorkflowCommand({envelope:body,payloadHash:hash});const worker=new WorkflowCommandWorker({registry,dispatch:async()=>{throw Object.assign(new Error('boom'),{code:'FIXTURE'});},projectStatus:null,logger:{info(){},error(){}}});assert.equal((await worker.process(body.command_id)).status,'FAILED');assert.equal(registry.getWorkflowCommand(body.command_id).errorCode,'FIXTURE');registry.close();});
test('native subscriber LaunchAgent is always-on and contains no secret',()=>{const plist=renderCommandSubscriberLaunchAgent({projectRoot:'/tmp/career-ops',npmPath:'/opt/homebrew/bin/npm',logsRoot:'/tmp/career-ops/logs'});assert.match(plist,/com\.careerops\.command-subscriber/);assert.match(plist,/command:subscriber/);assert.match(plist,/<key>KeepAlive<\/key><true\/>/);assert.match(plist,/<key>RunAtLoad<\/key><true\/>/);assert.doesNotMatch(plist,/COMMAND_SECRET|Docker|StartInterval/);});
