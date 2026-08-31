import http from 'http';
import { PubSub, v1 } from '@google-cloud/pubsub';
import { signRequest, signaturesEqual, validateEnvelope } from './contract.mjs';

const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
const readBody = (request, limit = 65536) => new Promise((resolve, reject) => { let body='';request.setEncoding('utf8');request.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>limit){reject(Object.assign(new Error('request body too large'),{statusCode:413}));request.destroy();}});request.on('end',()=>resolve(body));request.on('error',reject); });

export function createGatewayHandler({ secret, topicName, publisher, subscriber = null, clock = () => new Date(), replayWindowSeconds = 300, logger = console } = {}) {
  if (!secret || !topicName || !publisher?.publishMessage) throw new TypeError('secret, topicName, and publisher are required');
  const seen = new Map();
  return async function handler(request, response) {
    const started=Date.now(),path=new URL(request.url,'http://localhost').pathname;
    if(request.method==='GET'&&path==='/health')return json(response,200,{status:'healthy',publisher:'configured',subscriber:subscriber?'configured':'disabled',command_version:'3A.1'});
    const isPublish=request.method==='POST'&&path==='/v1/commands',isPull=request.method==='POST'&&path==='/v1/subscriptions/pull',isAck=request.method==='POST'&&path==='/v1/subscriptions/ack';
    if(!isPublish&&!isPull&&!isAck)return json(response,404,{error:'not_found'});
    const requestId=String(request.headers['x-career-ops-request-id']||''),timestamp=String(request.headers['x-career-ops-timestamp']||''),signature=String(request.headers['x-career-ops-signature']||'');
    try {
      if(!requestId||!timestamp||!signature)throw Object.assign(new Error('authentication headers required'),{statusCode:401});
      const at=new Date(timestamp).getTime(),now=clock().getTime();
      if(!Number.isFinite(at)||Math.abs(now-at)>replayWindowSeconds*1000)throw Object.assign(new Error('stale request timestamp'),{statusCode:401});
      for(const [id,expires] of seen)if(expires<=now)seen.delete(id);
      if(seen.has(requestId))throw Object.assign(new Error('replayed request id'),{statusCode:409});
      const rawBody=await readBody(request),expected=signRequest({secret,timestamp,requestId,rawBody});
      if(!signaturesEqual(signature,expected))throw Object.assign(new Error('invalid signature'),{statusCode:401});
      if((isPull||isAck)&&!subscriber)throw Object.assign(new Error('subscriber transport unavailable'),{statusCode:503});
      if(isPull){seen.set(requestId,now+replayWindowSeconds*1000);const messages=await subscriber.pull();return json(response,200,{messages});}
      if(isAck){const body=JSON.parse(rawBody||'{}');if(!String(body.ack_id||'').trim())throw Object.assign(new Error('ack_id is required'),{statusCode:400});if(body.disposition==='nack')await subscriber.nack(body.ack_id);else await subscriber.ack(body.ack_id);seen.set(requestId,now+replayWindowSeconds*1000);return json(response,200,{status:'ACKNOWLEDGED'});}
      const envelope=validateEnvelope(JSON.parse(rawBody));
      if(envelope.command_id!==requestId||envelope.requested_at!==timestamp)throw Object.assign(new Error('signed headers do not match envelope'),{statusCode:400});
      const messageId=await publisher.publishMessage({data:Buffer.from(rawBody),attributes:{command_type:envelope.command_type,command_version:envelope.command_version,command_id:envelope.command_id,correlation_id:envelope.correlation_id,source:envelope.source}});
      seen.set(requestId,now+replayWindowSeconds*1000);
      const acceptedAt=clock().toISOString();logger.info?.(JSON.stringify({event:'command_accepted',requestId,commandType:envelope.command_type,commandId:envelope.command_id,correlationId:envelope.correlation_id,messageId,latencyMs:Date.now()-started}));
      return json(response,202,{command_id:envelope.command_id,status:'QUEUED',accepted_at:acceptedAt});
    } catch(error) {
      const status=error instanceof SyntaxError?400:(error.statusCode||500);logger.warn?.(JSON.stringify({event:'command_rejected',requestId,reason:error.message,status,latencyMs:Date.now()-started}));return json(response,status,{error:status===500?'internal_error':error.message});
    }
  };
}

export class PubSubPullAdapter{
  constructor({projectId,subscriptionName,client=new v1.SubscriberClient()}={}){if(!projectId||!subscriptionName)throw new TypeError('projectId and subscriptionName are required');this.client=client;this.subscription=`projects/${projectId}/subscriptions/${subscriptionName}`;}
  async pull(){const[response]=await this.client.pull({subscription:this.subscription,maxMessages:1,returnImmediately:true});return(response.receivedMessages||[]).map(item=>({ack_id:item.ackId,message_id:item.message?.messageId||null,data:Buffer.from(item.message?.data||'').toString('base64'),attributes:item.message?.attributes||{},publish_time:item.message?.publishTime||null}));}
  async ack(ackId){await this.client.acknowledge({subscription:this.subscription,ackIds:[ackId]});}
  async nack(ackId){await this.client.modifyAckDeadline({subscription:this.subscription,ackIds:[ackId],ackDeadlineSeconds:0});}
}

export function startServer({ env = process.env } = {}) {
  const projectId=env.GOOGLE_CLOUD_PROJECT,topicName=env.CAREER_OPS_PUBSUB_TOPIC,secret=env.CAREER_OPS_COMMAND_SECRET,subscriptionName=env.CAREER_OPS_PUBSUB_SUBSCRIPTION;
  if(!projectId||!topicName||!secret)throw new Error('GOOGLE_CLOUD_PROJECT, CAREER_OPS_PUBSUB_TOPIC, and CAREER_OPS_COMMAND_SECRET are required');
  const pubsub=new PubSub({projectId}),publisher=pubsub.topic(topicName),subscriber=subscriptionName?new PubSubPullAdapter({projectId,subscriptionName}):null;const server=http.createServer(createGatewayHandler({secret,topicName,publisher,subscriber}));
  server.listen(Number(env.PORT||8080),()=>console.log(JSON.stringify({event:'gateway_started',port:Number(env.PORT||8080),topic:topicName})));
  return server;
}

if(import.meta.url===new URL(`file://${process.argv[1]}`).href)startServer();
