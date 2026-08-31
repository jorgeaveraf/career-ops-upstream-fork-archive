import http from 'http';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

const TOKEN_ENDPOINT='https://oauth2.googleapis.com/token';
const METADATA_TOKEN_URL='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const json=(response,status,body)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(body));};
const equal=(a,b)=>{const left=Buffer.from(String(a||'')),right=Buffer.from(String(b||''));return left.length===right.length&&timingSafeEqual(left,right);};
const signatureInput=({timestamp,requestId})=>`${timestamp}\n${requestId}\nPOST\n/v1/workspace-token`;
export const signBrokerRequest=({secret,timestamp,requestId})=>createHmac('sha256',secret).update(signatureInput({timestamp,requestId})).digest('base64url');
const base64url=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');

export async function mintDelegatedToken({serviceAccountEmail,subject,scopes,fetchImpl=globalThis.fetch,clock=()=>new Date()}={}){
  const metadata=await fetchImpl(METADATA_TOKEN_URL,{headers:{'Metadata-Flavor':'Google'}}).catch(cause=>{throw Object.assign(new Error(`Cloud Run metadata token unavailable: ${cause.message||cause}`),{code:'CLOUD_RUNTIME_IDENTITY_UNAVAILABLE'});});
  const metadataBody=await metadata.json().catch(()=>({}));
  if(!metadata.ok||!metadataBody.access_token)throw Object.assign(new Error('Cloud Run metadata token unavailable'),{code:'CLOUD_RUNTIME_IDENTITY_UNAVAILABLE'});
  const now=Math.floor(clock().getTime()/1000),header=base64url({alg:'RS256',typ:'JWT'}),claims=base64url({iss:serviceAccountEmail,sub:subject,scope:scopes.join(' '),aud:TOKEN_ENDPOINT,iat:now,exp:now+3600}),unsigned=`${header}.${claims}`;
  const signedResponse=await fetchImpl(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}:signBlob`,{method:'POST',headers:{Authorization:`Bearer ${metadataBody.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({payload:Buffer.from(unsigned).toString('base64')})}).catch(cause=>{throw Object.assign(new Error(`IAM signing unavailable: ${cause.message||cause}`),{code:'IAM_SIGNING_UNAVAILABLE'});});
  const signed=await signedResponse.json().catch(()=>({}));
  if(!signedResponse.ok||!signed.signedBlob)throw Object.assign(new Error(signed.error?.message||'IAM signBlob failed'),{code:'IAM_SIGNING_FAILED',status:signedResponse.status});
  const assertion=`${unsigned}.${Buffer.from(signed.signedBlob,'base64').toString('base64url')}`;
  const tokenResponse=await fetchImpl(TOKEN_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
  const token=await tokenResponse.json().catch(()=>({}));
  if(!tokenResponse.ok||!token.access_token)throw Object.assign(new Error(token.error_description||token.error||'DWD token exchange failed'),{code:'DWD_TOKEN_EXCHANGE_FAILED',status:tokenResponse.status});
  return{access_token:token.access_token,expires_in:Number(token.expires_in||3600),token_type:token.token_type||'Bearer',provider:'cloud_run_iam_remote_signing_dwd',principal:serviceAccountEmail,subject,scopes};
}

export function createBrokerHandler({secret,serviceAccountEmail,subject,scopes=['https://www.googleapis.com/auth/spreadsheets'],fetchImpl=globalThis.fetch,clock=()=>new Date(),replayWindowSeconds=300,logger=console}={}){
  if(!secret||!serviceAccountEmail||!subject)throw new TypeError('secret, serviceAccountEmail, and subject are required');
  const seen=new Map();
  return async(request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname;
    if(request.method==='GET'&&path==='/health')return json(response,200,{status:'healthy',provider:'cloud_run_iam_remote_signing_dwd',principal:serviceAccountEmail,subject});
    if(request.method!=='POST'||path!=='/v1/workspace-token')return json(response,404,{error:'not_found'});
    const requestId=String(request.headers['x-career-ops-request-id']||''),timestamp=String(request.headers['x-career-ops-timestamp']||''),signature=String(request.headers['x-career-ops-signature']||'');
    try{
      const at=new Date(timestamp).getTime(),now=clock().getTime();
      if(!requestId||!Number.isFinite(at)||Math.abs(now-at)>replayWindowSeconds*1000)throw Object.assign(new Error('invalid or stale authentication'),{statusCode:401,code:'BROKER_AUTH_INVALID'});
      for(const[id,expiry]of seen)if(expiry<=now)seen.delete(id);
      if(seen.has(requestId))throw Object.assign(new Error('replayed request id'),{statusCode:409,code:'BROKER_REPLAY'});
      if(!equal(signature,signBrokerRequest({secret,timestamp,requestId})))throw Object.assign(new Error('invalid authentication'),{statusCode:401,code:'BROKER_AUTH_INVALID'});
      seen.set(requestId,now+replayWindowSeconds*1000);
      return json(response,200,await mintDelegatedToken({serviceAccountEmail,subject,scopes,fetchImpl,clock}));
    }catch(error){logger.error?.(JSON.stringify({event:'workspace_token_failed',requestId,errorCode:error.code||'WORKSPACE_BROKER_FAILED'}));return json(response,error.statusCode||error.status||503,{error:error.code||'WORKSPACE_BROKER_FAILED',detail:String(error.message).slice(0,300)});}
  };
}

export function startServer({env=process.env}={}){
  const secret=env.CAREER_OPS_WORKSPACE_BROKER_SECRET,serviceAccountEmail=env.WORKSPACE_SERVICE_ACCOUNT_EMAIL,subject=env.WORKSPACE_DELEGATED_USER;
  const scopes=String(env.WORKSPACE_SCOPES||'https://www.googleapis.com/auth/spreadsheets').split(/[ ,]+/).filter(Boolean);
  const server=http.createServer(createBrokerHandler({secret,serviceAccountEmail,subject,scopes}));server.listen(Number(env.PORT||8080),()=>console.log(JSON.stringify({event:'workspace_auth_broker_started',port:Number(env.PORT||8080),provider:'cloud_run_iam_remote_signing_dwd'})));return server;
}
if(import.meta.url===new URL(`file://${process.argv[1]}`).href)startServer();
