import {hashStable} from '../acquisition/normalize.mjs';

const text=(value,name)=>{const result=String(value||'').trim();if(!result)throw new TypeError(`${name} is required`);return result;};

export function createApplicationSubmitCapability({authorization,execution=null,now=new Date(),ttlMinutes=30}={}){
  const plan=authorization?.executionPlan;const resumable=new Set(['APPROVED_TO_APPLY','EXECUTING','NEEDS_HUMAN']);if(!authorization?.id||!resumable.has(authorization.status)||plan?.status!=='READY')throw new Error('exact approved application authorization is required');
  if(execution?.status==='NEEDS_HUMAN'&&execution?.blocker?.code==='VERIFICATION_UNKNOWN')throw new Error('ambiguous application verification cannot authorize submit');
  const target=new URL(text(plan.primaryTarget,'primaryTarget'));if(target.protocol!=='https:')throw new Error('application target must use HTTPS');
  const capability={version:'2D.2',action:'application.submit',authorizationId:authorization.id,jobId:authorization.jobId,planHash:plan.planHash,packageId:plan.packageId,packageVersion:plan.packageVersion,allowedOrigin:target.origin,allowedUrl:target.toString(),issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+Math.max(1,Number(ttlMinutes)||30)*60000).toISOString()};
  return Object.freeze({...capability,capabilityHash:hashStable(JSON.stringify(capability))});
}

export function assertApplicationSubmitCapability(capability,{authorization,plan,url,now=new Date()}={}){
  if(capability?.action!=='application.submit')throw new Error('application.submit capability is required');
  if(capability.authorizationId!==authorization?.id||capability.jobId!==authorization?.jobId)throw new Error('capability authorization/job mismatch');
  if(capability.planHash!==plan?.planHash||capability.packageId!==plan?.packageId||capability.packageVersion!==plan?.packageVersion)throw new Error('capability package/plan mismatch');
  if(now.getTime()>new Date(capability.expiresAt).getTime())throw new Error('application.submit capability expired');
  const target=new URL(url||plan.primaryTarget);if(target.protocol!=='https:'||target.origin!==capability.allowedOrigin)throw new Error('application target domain is not authorized');
  return true;
}
