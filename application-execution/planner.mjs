import {hashStable} from '../acquisition/normalize.mjs';
import {PRIMARY_APPLICATION_CHANNELS,SECONDARY_OUTREACH_CHANNELS} from './contracts.mjs';

const clean=v=>String(v||'').trim();
const primaryFor=path=>({ATS:'ATS',EMAIL:'EMAIL',PLATFORM:'PLATFORM',OTHER:'MANUAL_EXTERNAL',RECRUITER_CONTACT:'MANUAL_EXTERNAL',UNKNOWN:'UNKNOWN'})[path]||'UNKNOWN';
export function buildExecutionPlan({job,request,packageRecord,evaluation,now=new Date(),maxEvidenceAgeDays=30}={}){
  const blockers=[];
  if(!job?.id)blockers.push('MISSING_JOB');
  if(request?.status!=='READY_FOR_REVIEW')blockers.push('NOT_READY_FOR_REVIEW');
  if(evaluation?.recommendation!=='APPLY'||evaluation?.status!=='VALID')blockers.push('EVALUATION_NOT_APPLY');
  if(!packageRecord||packageRecord.validationStatus!=='VALID')blockers.push('PACKAGE_NOT_VALID');
  if(!request?.applicationPlan||request.applicationPlan.status!=='READY')blockers.push('APPLICATION_PLAN_NOT_READY');
  if((request?.researchState?.openNeeds||[]).some(x=>x.status==='OPEN'&&x.priority==='HIGH'&&/conflict|contradiction/i.test(x.reason||'')))blockers.push('CRITICAL_CONTRADICTION');
  const updated=new Date(request?.updatedAt||request?.requestedAt||0).getTime();if(!Number.isFinite(updated)||now.getTime()-updated>maxEvidenceAgeDays*86400000)blockers.push('STALE_EVIDENCE');
  const primaryChannel=primaryFor(request?.applicationPlan?.primaryPath);if(!PRIMARY_APPLICATION_CHANNELS.includes(primaryChannel)||primaryChannel==='UNKNOWN')blockers.push('UNKNOWN_PRIMARY_CHANNEL');
  const executionMode=['ATS','EMAIL'].includes(primaryChannel)?'NATIVE':['PLATFORM','MANUAL_EXTERNAL'].includes(primaryChannel)?'GENERIC_BROWSER':'MANUAL_SECURITY_BOUNDARY';
  // Application authorization is intentionally application-only. Outreach has
  // its own exact plan, human decision, authorization and execution record.
  const secondaryChannel='NONE';
  const artifacts=request?.artifactManifest?.files||{};const requiredArtifacts=[primaryChannel==='EMAIL'?'resume.md':'resume.pdf'];if(primaryChannel!=='EMAIL'&&request?.artifactManifest?.coverLetterStatus==='READY')requiredArtifacts.push('cover-letter.pdf');
  for(const name of requiredArtifacts)if(!artifacts[name]?.path||!artifacts[name]?.hash)blockers.push(`MISSING_ARTIFACT:${name}`);
  const plan={version:'4.3.3',jobId:job?.id||'',enrichmentRequestId:request?.id||'',packageId:packageRecord?.id||'',packageVersion:packageRecord?.packageVersion||null,primaryChannel,primaryTarget:request?.applicationPlan?.email||request?.applicationPlan?.url||'',executionMode,executor:executionMode==='NATIVE'?(primaryChannel==='ATS'?'ATS_CHROME':'EMAIL_TRANSPORT'):executionMode==='GENERIC_BROWSER'?'GENERIC_BROWSER':null,capabilityVerifiedAt:now.toISOString(),secondaryChannel,secondaryTarget:'',requiredArtifacts,artifactHashes:Object.fromEntries(requiredArtifacts.map(name=>[name,artifacts[name]?.hash||''])),resolvedApplicationQuestions:request?.applicationPlan?.resolvedQuestions||request?.applicationPlan?.answers||[],applicationInstructions:request?.applicationPlan?.instructions||'',humanRequirements:request?.applicationPlan?.manualRequirements||[],evidenceAgeDays:Number.isFinite(updated)?Math.max(0,Math.floor((now.getTime()-updated)/86400000)):null,blockers};
  return{...plan,status:blockers.length?'BLOCKED':'READY',planHash:hashStable(JSON.stringify(plan))};
}
