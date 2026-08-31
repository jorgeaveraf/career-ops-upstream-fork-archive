import { randomUUID } from 'crypto';

export async function drainApplicationEnrichment({worker,maxItems=10,maxRuntimeMs=30*60_000,jobId=null,requestId=null,useLLM=false,onClaimed=null,onTerminal=null,clock=()=>Date.now()}={}){
  if(!worker)throw new TypeError('worker is required');
  const started=clock(),results=[],runId=`enrichment-drain-${randomUUID()}`;
  const itemLimit=Math.max(1,Math.min(100,Number(maxItems)||10));
  const runtimeLimit=Math.max(1000,Number(maxRuntimeMs)||30*60_000);
  for(let index=0;index<itemLimit&&clock()-started<runtimeLimit;index++){
    const result=await worker.processNext({runId,jobId,requestId:results.length?null:requestId,useLLM,onClaimed});
    if(result.status==='NO_WORK')break;
    results.push(result);
    await onTerminal?.(result);
  }
  const remaining=worker.registry.listEnrichmentRequests({status:'PENDING',jobId}).length;
  const status=results.some(x=>x.status==='FAILED')?'PARTIAL':remaining?'BOUNDED':'SUCCESS';
  const digest=worker.registry.notificationOutbox?.enqueueWorkflowDigest?.({runId,status,results})||{status:'UNAVAILABLE'};
  return{status,runId,processed:results.length,remaining,durationMs:clock()-started,results,digest};
}
