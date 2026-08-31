import { PubSub } from '@google-cloud/pubsub';
import { createHmac, randomUUID } from 'crypto';
import { commandPayloadHash, validateCommandEnvelope } from './command-contract.mjs';
import { WorkflowCommandWorker } from './command-worker.mjs';

export class CommandSubscriber {
  constructor({ registry, subscriptionName, projectId, pubsub = null, transport = null, worker = null, logger = console, pollIntervalMs = 1000 } = {}) {
    if (!registry || !subscriptionName) throw new TypeError('registry and subscriptionName are required');
    this.registry = registry; this.subscriptionName = subscriptionName; this.projectId = projectId;
    this.transport=transport;this.pubsub = transport?null:(pubsub || new PubSub({ projectId })); this.worker = worker || new WorkflowCommandWorker({ registry, logger }); this.logger = logger;this.pollIntervalMs=pollIntervalMs;
    this.subscription = null; this.queue = Promise.resolve();this.closed=false;this.pollTimer=null;
  }

  async handleMessage(message) {
    let envelope;
    try {
      envelope = validateCommandEnvelope(JSON.parse(message.data.toString('utf8')));
      const payloadHash = commandPayloadHash(envelope);
      const received = this.registry.receiveWorkflowCommand({ envelope, payloadHash, pubsubMessageId: message.id });
      await message.ack();
      this.logger.info?.(JSON.stringify({ event: 'command_received', commandId: envelope.command_id, commandType: envelope.command_type, correlationId: envelope.correlation_id, pubsubMessageId: message.id, duplicate: received.duplicate }));
      if (received.duplicate && !['RECEIVED','PROCESSING'].includes(received.command.status)) return { status: 'IGNORED_DUPLICATE', command: received.command };
      return this.worker.process(envelope.command_id);
    } catch (error) {
      this.logger.error?.(JSON.stringify({ event: 'command_rejected', pubsubMessageId: message.id, error: error.message }));
      await message.nack();
      return { status: 'REJECTED', error };
    }
  }

  async start() {
    await this.worker.recover();
    if(this.transport){this.logger.info?.(JSON.stringify({event:'subscriber_started',subscription:this.subscriptionName,projectId:this.projectId,provider:'command_gateway_pull'}));this.schedulePoll(0);return this;}
    this.subscription = this.pubsub.subscription(this.subscriptionName, {
      flowControl: { maxMessages: 1, allowExcessMessages: false },
    });
    this.subscription.on('message', message => { this.queue = this.queue.then(() => this.handleMessage(message)).catch(error => this.logger.error?.(error)); });
    this.subscription.on('error', error => this.logger.error?.(JSON.stringify({ event: 'subscriber_error', error: error.message })));
    this.logger.info?.(JSON.stringify({ event: 'subscriber_started', subscription: this.subscriptionName, projectId: this.projectId }));
    return this;
  }

  schedulePoll(delay=this.pollIntervalMs){if(this.closed)return;this.pollTimer=setTimeout(()=>{this.queue=this.queue.then(()=>this.pollGateway()).catch(error=>this.logger.error?.(JSON.stringify({event:'subscriber_error',provider:'command_gateway_pull',error:error.message}))).finally(()=>this.schedulePoll());},delay);}
  async pollGateway(){const messages=await this.transport.pull();for(const item of messages){const message={id:item.message_id,data:Buffer.from(item.data,'base64'),ack:()=>this.transport.ack(item.ack_id),nack:()=>this.transport.nack(item.ack_id)};await this.handleMessage(message);}}

  async close() { this.closed=true;if(this.pollTimer)clearTimeout(this.pollTimer);await this.queue;await this.subscription?.close();await this.pubsub?.close(); }
}

export class CommandGatewayPullTransport{
  constructor({url,secret,fetchImpl=globalThis.fetch,clock=()=>new Date()}={}){if(!url||!secret)throw new TypeError('command gateway URL and secret are required');this.url=String(url).replace(/\/$/,'');this.secret=secret;this.fetch=fetchImpl;this.clock=clock;}
  async request(path,body={}){const rawBody=JSON.stringify(body),timestamp=this.clock().toISOString(),requestId=randomUUID(),signature=createHmac('sha256',this.secret).update(`${timestamp}\n${requestId}\n${rawBody}`).digest('base64url');let response;try{response=await this.fetch(`${this.url}${path}`,{method:'POST',headers:{'content-type':'application/json','x-career-ops-request-id':requestId,'x-career-ops-timestamp':timestamp,'x-career-ops-signature':signature},body:rawBody,signal:AbortSignal.timeout(15000)});}catch(cause){const error=new Error(`Command gateway unavailable: ${cause.message||cause}`);error.code='COMMAND_GATEWAY_UNAVAILABLE';throw error;}const result=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(`Command gateway ${response.status}: ${result.error||response.statusText}`);error.code=response.status===401?'COMMAND_GATEWAY_AUTH_FAILED':'COMMAND_GATEWAY_PULL_FAILED';throw error;}return result;}
  async pull(){return(await this.request('/v1/subscriptions/pull')).messages||[];}
  async ack(ackId){await this.request('/v1/subscriptions/ack',{ack_id:ackId,disposition:'ack'});}
  async nack(ackId){await this.request('/v1/subscriptions/ack',{ack_id:ackId,disposition:'nack'});}
}
