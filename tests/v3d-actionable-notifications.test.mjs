import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { JobRegistry } from '../registry/job-registry.mjs';
import { NotificationPolicyEngine } from '../notifications/policy.mjs';
import { NotificationOutboxService, NotificationDeliveryWorker } from '../notifications/outbox.mjs';
import { renderActionableNotification } from '../notifications/templates.mjs';
import { ResendEmailProvider } from '../automation/notification-provider.mjs';
import { buildControlPlaneProjection } from '../human-control-plane/projection.mjs';

const START = new Date('2026-08-28T15:00:00.000Z');
const enabledPreferences = {enabled:true,recipient:'jorgeaveraf@gmail.com',channel:'email',provider:'resend',events:{NEEDS_HUMAN:true,READY_FOR_REVIEW:true,APPLICATION_CONFIRMED:true,APPLICATION_FAILED:true,COMMAND_FAILED:true,ENRICHMENT_BLOCKED:true,COMMUNITY_NEEDS_HUMAN:true}};
const registry = clock => new JobRegistry({dbPath:':memory:',clock,env:{CAREER_OPS_NOTIFICATIONS_ENABLED:'false'}});
const event = (eventType, refs={}, payload={}) => ({eventType,refs:{aggregateType:'APPLICATION',aggregateId:'app-1',...refs},payload,eventId:'event-1',correlationId:'correlation-1',timestamp:START.toISOString()});

function outboxFor(r, preferences=enabledPreferences, clock=()=>START) {
  return new NotificationOutboxService({db:r.db,eventWriter:r.workflowEvents,preferences,clock,sheetUrl:'https://docs.google.com/spreadsheets/d/sheet/edit'});
}

function failedCommandFixture(r) {
  const commandId=randomUUID(),correlationId=randomUUID(),at=START.toISOString();
  const envelope={command_version:'3A.1',command_id:commandId,command_type:'jobs.sync',requested_at:at,source:'google_sheet',sheet_id:'sheet',requested_by:'jorge',correlation_id:correlationId,payload:{}};
  r.db.prepare(`INSERT INTO workflow_commands(command_id,command_type,correlation_id,source,requested_at,received_at,completed_at,status,attempt_count,payload_hash,envelope_json,result_summary,error_code,error_message,version) VALUES(?,?,?,?,?,?,?,'FAILED',1,?,?,'{}','FIXTURE_FAILED','Fixture failure','3A.1')`).run(commandId,'jobs.sync',correlationId,'google_sheet',at,at,at,'fixture-hash',JSON.stringify(envelope));
  const written=r.recordWorkflowEvent({eventType:'COMMAND_FAILED',aggregateType:'COMMAND',aggregateId:commandId,correlationId,commandId,occurredAt:at,source:'command_subscriber',actorType:'SYSTEM',payload:{status:'FAILED',errorCode:'FIXTURE_FAILED'},metadata:{refs:{commandId}},dedupeKey:`fixture:${commandId}:failed`});
  return {commandId,correlationId,row:written.event};
}

function createCommandIntent(r, outbox=outboxFor(r)) {
  const fixture=failedCommandFixture(r);const captured=outbox.capture(fixture.row);
  assert.equal(captured.status,'PENDING');return {outbox,fixture,delivery:captured.delivery};
}

test('policy allowlists actionable outcomes and suppresses routine activity',()=>{
  const policy=new NotificationPolicyEngine();
  assert.deepEqual(policy.evaluate({event:event('APPLICATION_NEEDS_HUMAN'),domain:{},preferences:enabledPreferences}),{decision:'NOTIFY',notificationType:'NEEDS_HUMAN',priority:'HIGH'});
  assert.equal(policy.evaluate({event:event('APPLICATION_EXECUTION_STARTED'),domain:{},preferences:enabledPreferences}).decision,'SUPPRESS');
  assert.equal(policy.evaluate({event:event('PACKAGE_GENERATED'),domain:{},preferences:enabledPreferences}).decision,'SUPPRESS');
  assert.equal(policy.evaluate({event:event('NOTIFICATION_SENT',{aggregateType:'NOTIFICATION'}),domain:{},preferences:enabledPreferences}).decision,'SUPPRESS');
});

test('READY_FOR_REVIEW waits for authoritative ready state and a valid package',()=>{
  const policy=new NotificationPolicyEngine(),ready=event('ENRICHMENT_COMPLETED');
  assert.equal(policy.evaluate({event:ready,domain:{enrichmentReady:true,packageValid:false},preferences:enabledPreferences}).decision,'DEFER');
  assert.equal(policy.evaluate({event:ready,domain:{enrichmentReady:true,packageValid:true},preferences:enabledPreferences}).decision,'NOTIFY');
});

test('command and community notifications require explicit human authorization',()=>{
  const policy=new NotificationPolicyEngine();
  assert.equal(policy.evaluate({event:event('COMMAND_FAILED'),domain:{userInitiatedCommand:false},preferences:enabledPreferences}).decision,'SUPPRESS');
  assert.equal(policy.evaluate({event:event('COMMAND_FAILED'),domain:{userInitiatedCommand:true},preferences:enabledPreferences}).decision,'NOTIFY');
  assert.equal(policy.evaluate({event:event('COMMUNITY_NEEDS_HUMAN'),domain:{authorizedCommunityJoin:false},preferences:enabledPreferences}).decision,'SUPPRESS');
});

test('templates are deterministic, Spanish, actionable, linked, and contain no internal IDs',()=>{
  const context={company:'Acme',role:'AI Engineer',stage:'APPLY',humanBlocker:'Confirma tu disponibilidad.',recommendedAction:'Responde en TODAY.',sheetUrl:'https://docs.google.com/spreadsheets/d/sheet/edit'};
  const first=renderActionableNotification('NEEDS_HUMAN',context),second=renderActionableNotification('NEEDS_HUMAN',context);
  assert.deepEqual(first,second);assert.match(first.subject,/Career Ops necesita tu respuesta/);assert.match(first.text,/Siguiente acción:/);assert.match(first.text,/Abrir TODAY:/);assert.doesNotMatch(first.text,/[a-f0-9]{8}-[a-f0-9-]{27,}/i);
  assert.deepEqual(renderActionableNotification('DELIVERY_PROBE',{}),{subject:'Career Ops notification test',text:'Career Ops V3D notification delivery is working.',templateVersion:'4.4'});
});

test('outbox persists once and deduplicates by event, type, and recipient',()=>{const r=registry(()=>START);try{const {row}=failedCommandFixture(r),outbox=outboxFor(r);const first=outbox.capture(row),second=outbox.capture(row);assert.equal(first.status,'PENDING');assert.equal(second.status,'DEDUPLICATED');assert.equal(r.db.prepare('SELECT COUNT(*) count FROM notification_deliveries').get().count,1);assert.equal(r.db.prepare("SELECT COUNT(*) count FROM workflow_events WHERE event_type='NOTIFICATION_REQUIRED'").get().count,1);}finally{r.close();}});

test('disabled preferences persist a disabled intent without invoking a provider',()=>{const r=registry(()=>START);try{const {row}=failedCommandFixture(r),preferences={...enabledPreferences,enabled:false},outbox=outboxFor(r,preferences);const captured=outbox.capture(row);assert.equal(captured.status,'DISABLED');assert.equal(r.db.prepare("SELECT event_type FROM workflow_events WHERE aggregate_id=? ORDER BY created_at DESC LIMIT 1").get(captured.delivery.id).event_type,'NOTIFICATION_DISABLED');}finally{r.close();}});

test('successful delivery records provider ID and preserves correlation/causation chain',async()=>{const r=registry(()=>START);try{const {outbox,fixture,delivery}=createCommandIntent(r);const provider={sendSummary:async()=>({id:'provider-message-1'})};const result=await new NotificationDeliveryWorker({outbox,provider,clock:()=>START}).processOne();assert.equal(result.status,'SENT');assert.equal(result.delivery.providerMessageId,'provider-message-1');const events=r.db.prepare("SELECT event_id,event_type,correlation_id,causation_id FROM workflow_events WHERE aggregate_id=? ORDER BY created_at,rowid").all(delivery.id);assert.deepEqual(events.map(x=>x.event_type),['NOTIFICATION_REQUIRED','NOTIFICATION_SENT']);assert.ok(events.every(x=>x.correlation_id===fixture.correlationId));assert.equal(events[0].causation_id,fixture.row.event_id);assert.equal(events[1].causation_id,events[0].event_id);}finally{r.close();}});

test('stale actionable intent is suppressed before provider invocation',async()=>{const r=registry(()=>START);try{const {outbox,fixture,delivery}=createCommandIntent(r);r.db.prepare("UPDATE workflow_commands SET status='SUCCESS' WHERE command_id=?").run(fixture.commandId);let sends=0;const result=await new NotificationDeliveryWorker({outbox,provider:{sendSummary:async()=>{sends++;return{id:'nope'};}},clock:()=>START}).processOne();assert.equal(result.status,'SUPPRESSED_STALE');assert.equal(sends,0);assert.equal(result.delivery.errorCode,'SUPPRESSED_STALE');const disabled=r.db.prepare("SELECT causation_id FROM workflow_events WHERE aggregate_id=? AND event_type='NOTIFICATION_DISABLED'").get(delivery.id);const required=r.db.prepare("SELECT event_id FROM workflow_events WHERE aggregate_id=? AND event_type='NOTIFICATION_REQUIRED'").get(delivery.id);assert.equal(disabled.causation_id,required.event_id);}finally{r.close();}});

test('transient failures retry with backoff while permanent and ambiguous outcomes stop',async()=>{
  let now=new Date(START);const clock=()=>now;
  const r=registry(clock);try{const first=createCommandIntent(r,outboxFor(r,enabledPreferences,clock));let attempts=0;const transient={sendSummary:async()=>{attempts++;if(attempts===1){const error=new Error('later');error.code='EMAIL_SEND_TRANSIENT';error.transient=true;throw error;}return{id:'retry-ok'};}};const worker=new NotificationDeliveryWorker({outbox:first.outbox,provider:transient,clock});assert.equal((await worker.processOne()).status,'RETRY_SCHEDULED');assert.equal((await worker.processOne()).status,'NO_WORK');now=new Date(START.getTime()+10_001);assert.equal((await worker.processOne()).status,'SENT');assert.equal(attempts,2);
    const second=createCommandIntent(r,outboxFor(r,enabledPreferences,clock));let permanentCalls=0;const permanentError=new Error('bad request');permanentError.code='EMAIL_SEND_PERMANENT';const permanent=new NotificationDeliveryWorker({outbox:second.outbox,provider:{sendSummary:async()=>{permanentCalls++;throw permanentError;}},clock});assert.equal((await permanent.processOne()).status,'FAILED');assert.equal((await permanent.processOne()).status,'NO_WORK');assert.equal(permanentCalls,1);
    const third=createCommandIntent(r,outboxFor(r,enabledPreferences,clock));const ambiguousError=new Error('unknown');ambiguousError.code='EMAIL_SEND_AMBIGUOUS';ambiguousError.ambiguous=true;const ambiguous=new NotificationDeliveryWorker({outbox:third.outbox,provider:{sendSummary:async()=>{throw ambiguousError;}},clock});assert.equal((await ambiguous.processOne()).status,'AMBIGUOUS');assert.equal((await ambiguous.processOne()).status,'NO_WORK');
  }finally{r.close();}
});

test('Resend provider sends idempotency key and classifies provider failures',async()=>{
  let request;const provider=new ResendEmailProvider({apiKey:'secret',from:'Career Ops <career@brunova.mx>',to:'jorgeaveraf@gmail.com',fetchImpl:async(url,options)=>{request={url,options};return{ok:true,json:async()=>({id:'resend-1'})};}});assert.equal((await provider.sendSummary({subject:'s',text:'b',idempotencyKey:'stable'})).id,'resend-1');assert.equal(request.options.headers['Idempotency-Key'],'stable');assert.deepEqual(JSON.parse(request.options.body).to,['jorgeaveraf@gmail.com']);
  const transport=new ResendEmailProvider({apiKey:'secret',from:'a@b.com',to:'c@d.com',fetchImpl:async()=>{throw new Error('socket closed');}});await assert.rejects(()=>transport.sendSummary({subject:'s',text:'b',idempotencyKey:'k'}),error=>error.code==='EMAIL_SEND_AMBIGUOUS'&&error.ambiguous===true);
});

test('delivery probe persists the exact harmless message without job state',()=>{const r=registry(()=>START);try{const delivery=outboxFor(r).enqueueDeliveryProbe();assert.equal(delivery.status,'PENDING');assert.equal(delivery.subject,'Career Ops notification test');assert.equal(delivery.bodyText,'Career Ops V3D notification delivery is working.');assert.equal(r.db.prepare("SELECT event_type FROM workflow_events WHERE aggregate_id=?").get(delivery.id).event_type,'NOTIFICATION_REQUIRED');}finally{r.close();}});

test('SETTINGS exposes compact notification state without provider secrets',()=>{const r=registry(()=>START);try{const projection=buildControlPlaneProjection(r.getControlPlaneData());const settings=new Map(projection.tabs.SETTINGS.map(row=>[row.Key,row.Value]));assert.equal(settings.get('Notifications Enabled'),'DISABLED');assert.equal(settings.get('Last Notification'),'NONE');assert.equal(settings.get('Last Daily Summary'),'NONE');assert.equal(settings.get('Daily Summary Enabled'),'ENABLED');assert.ok(settings.has('Needs Your Attention'));assert.equal([...settings.keys()].some(key=>/api|secret/i.test(key)),false);}finally{r.close();}});
