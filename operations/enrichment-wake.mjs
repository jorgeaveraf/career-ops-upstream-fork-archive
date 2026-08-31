import { execFileSync } from 'child_process';
import { APPLICATION_ENRICHMENT_LAUNCH_AGENT_LABEL } from './launch-agent.mjs';

export function wakeApplicationEnrichment({exec=execFileSync,uid=process.getuid?.(),label=APPLICATION_ENRICHMENT_LAUNCH_AGENT_LABEL}={}){
  if(!Number.isInteger(uid))throw Object.assign(new Error('launchctl user domain requires a numeric UID'),{code:'ENRICHMENT_WAKE_CONFIG'});
  exec('/bin/launchctl',['kickstart',`gui/${uid}/${label}`],{encoding:'utf8'});
  return{status:'WAKE_REQUESTED',label};
}
