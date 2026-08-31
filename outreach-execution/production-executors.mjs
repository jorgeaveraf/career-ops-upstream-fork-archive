import { CandidateGmailTokenProvider, CandidateGmailTransport, inspectCandidateGmailConfig } from './gmail-transport.mjs';
import { createLinkedInTransport, inspectLinkedInOutreachConfig } from './linkedin-transport.mjs';

export function createProductionOutreachExecutors({env=process.env,fetchImpl=globalThis.fetch}={}){
  const executors={};
  if(inspectCandidateGmailConfig(env).status==='READY'){
    const gmail=new CandidateGmailTransport({tokenProvider:new CandidateGmailTokenProvider({env,fetchImpl}),fetchImpl});
    for(const channel of ['RECRUITER_EMAIL','HIRING_MANAGER_EMAIL','GENERAL_RECRUITING'])executors[channel]=gmail;
  }
  if(inspectLinkedInOutreachConfig(env).status==='READY')executors.LINKEDIN_PROFILE=createLinkedInTransport({env});
  return executors;
}
export function inspectProductionOutreachTransports({env=process.env}={}){return{gmail:inspectCandidateGmailConfig(env),linkedin:inspectLinkedInOutreachConfig(env),scheduler:{status:'READY',detail:'Durable registry schedule with America/Mexico_City business-day semantics'},registry:{status:'READY',detail:'Schema-backed exact authorization, execution, provider identity, verification, and outcome state'}};}

