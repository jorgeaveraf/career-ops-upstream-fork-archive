const APPLIED = 'APPLIED_CONFIRMED';
const NOT_APPLIED = 'NOT_APPLIED_CONFIRMED';
const UNKNOWN = 'VERIFICATION_UNKNOWN';

const strongAppliedSources = new Set(['ATS_CONFIRMATION', 'SUCCESS_PAGE', 'PORTAL_HISTORY', 'CONFIRMATION_EMAIL', 'EXTERNAL_APPLICATION_ID']);

const clean=value=>String(value||'').trim();
const lower=value=>clean(value).toLowerCase();
const SUCCESS_TITLE=/(application|postulaci[oó]n).*(sent|submitted|enviad[ao])|se envi[oó] tu postulaci[oó]n/i;
const SUCCESS_PATH=/(post-apply|application[-_/]?(submitted|success|complete)|thank[-_/]?you)/i;

export function collectExecutionConfirmationEvidence(execution, { observedAt = null } = {}) {
  if (!execution) return [];
  const evidence=[];
  if (execution.confirmation?.id || execution.confirmation?.url || execution.confirmation?.messageId) evidence.push({ outcome:APPLIED,source:execution.confirmation.source||'ATS_CONFIRMATION',...execution.confirmation });
  const session=execution.sessionContext?.handoffSession||execution.sessionContext||{},pages=Array.isArray(session.pages)?session.pages:[];
  const success=pages.findLast?.(page=>SUCCESS_PATH.test(clean(page?.url))&&SUCCESS_TITLE.test(clean(page?.title)))||[...pages].reverse().find(page=>SUCCESS_PATH.test(clean(page?.url))&&SUCCESS_TITLE.test(clean(page?.title)));
  if(success)evidence.push({outcome:APPLIED,source:'SUCCESS_PAGE',provider:lower(new URL(success.url).hostname).includes('indeed')?'indeed':'browser',url:success.url,title:success.title,observedAt:observedAt||session.pausedAt||execution.updatedAt,executionId:execution.id});
  return evidence;
}

export function correlateConfirmationEmail({message,execution,job,windowHours=168}={}){
  if(!message||!execution||!job)return null;
  const subject=clean(message.headers?.subject),snippet=clean(message.snippet),haystack=lower(`${subject} ${snippet}`),company=lower(job.company),role=lower(job.title),recipient=lower(`${message.headers?.to||''} ${message.headers?.['delivered-to']||''}`),at=new Date(message.internalDate).getTime(),start=new Date(execution.startedAt||execution.createdAt).getTime(),within=Number.isFinite(at)&&Number.isFinite(start)&&at>=start-3600000&&at<=start+windowHours*3600000;
  const confirmation=/(application|postulaci[oó]n).*(sent|submitted|received|enviad[ao]|recibid[ao])|thanks for applying|postulaci[oó]n enviada/i.test(`${subject} ${snippet}`),identity=company&&haystack.includes(company),roleMatch=role&&haystack.includes(role),recipientKnown=/jorgeaveraf@gmail\.com|fubifo@gmail\.com/.test(recipient);
  if(!within||!confirmation||!recipientKnown||(!identity&&!roleMatch))return null;
  return{outcome:APPLIED,source:'CONFIRMATION_EMAIL',provider:'gmail',messageId:message.id,threadId:message.threadId,subject,observedAt:message.internalDate,recipientMatched:true,companyMatched:Boolean(identity),roleMatched:Boolean(roleMatch),executionId:execution.id};
}

export function classifyApplicationReconciliation(evidence = []) {
  const items = Array.isArray(evidence) ? evidence : [];
  const applied = items.find(item => item?.outcome === APPLIED && strongAppliedSources.has(item?.source));
  if (applied) return { outcome: APPLIED, confidence: 'HIGH', decisiveEvidence: applied, evidence: items };
  const notApplied = items.find(item => item?.outcome === NOT_APPLIED && item?.explicitNotApplied === true);
  if (notApplied) return { outcome: NOT_APPLIED, confidence: 'HIGH', decisiveEvidence: notApplied, evidence: items };
  return { outcome: UNKNOWN, confidence: 'LOW', decisiveEvidence: null, evidence: items };
}

export function mayResumeApplicationExecution(execution, reconciliation = null) {
  if (!execution || execution.status === 'APPLIED') return false;
  const outcome = reconciliation?.outcome || (execution.blocker?.code === NOT_APPLIED ? NOT_APPLIED : execution.blocker?.code);
  return outcome === NOT_APPLIED;
}

function confirmationFrom(evidence = {}) {
  const confirmation = { source: evidence.source, observedAt: evidence.observedAt };
  if (evidence.applicationId) confirmation.id = evidence.applicationId;
  if (evidence.messageId) confirmation.messageId = evidence.messageId;
  if (evidence.url) confirmation.url = evidence.url;
  if (!confirmation.id && !confirmation.messageId && !confirmation.url) confirmation.id = `reconciled:${evidence.source}`;
  return confirmation;
}

export function persistApplicationReconciliation({ registry, executionId, reconciliation } = {}) {
  if (!registry) throw new TypeError('registry is required');
  const current = registry.getApplicationExecution(executionId);
  if (!current) throw new Error('unknown application execution');
  if (current.status === 'APPLIED') return current;
  const evidence = reconciliation?.evidence || [];
  if (reconciliation?.outcome === APPLIED) {
    return registry.finishApplicationExecution(executionId, {
      status: 'APPLIED', stage: 'RECONCILIATION', reason: 'strong external application confirmation reconciled',
      confirmation: { ...confirmationFrom(reconciliation.decisiveEvidence), reconciliationOutcome: APPLIED, evidence },
    });
  }
  if (reconciliation?.outcome === NOT_APPLIED) {
    return registry.finishApplicationExecution(executionId, {
      status: 'NEEDS_HUMAN', stage: 'RECONCILIATION', reason: 'positive external evidence confirms no application was created',
      blocker: { code: NOT_APPLIED, question: 'Application is confirmed not submitted', resumptionPermitted: true, evidence },
    });
  }
  return registry.finishApplicationExecution(executionId, {
    status: 'NEEDS_HUMAN', stage: 'RECONCILIATION', reason: 'verification-only reconciliation remained ambiguous; automatic retry forbidden',
    blocker: { code: UNKNOWN, question: 'Application submission could not be verified', resumptionPermitted: false, evidence },
  });
}

export class ApplicationConfirmationReconciler {
  constructor({registry}={}){if(!registry)throw new TypeError('registry is required');this.registry=registry;}
  inspect(executionId,{evidence=[]}={}){const execution=this.registry.getApplicationExecution(executionId);if(!execution)throw new Error('unknown application execution');return classifyApplicationReconciliation([...collectExecutionConfirmationEvidence(execution),...evidence]);}
  reconcile(executionId,{evidence=[]}={}){
    const execution=this.registry.getApplicationExecution(executionId);if(!execution)throw new Error('unknown application execution');if(execution.status==='APPLIED')return{status:'ALREADY_APPLIED',execution,reconciliation:this.inspect(executionId,{evidence})};
    const reconciliation=this.inspect(executionId,{evidence});if(reconciliation.outcome!==APPLIED)return{status:'UNCONFIRMED',execution,reconciliation};
    const decisive=reconciliation.decisiveEvidence,confirmation={...confirmationFrom(decisive),provider:decisive.provider||null,type:decisive.source,title:decisive.title||decisive.subject||'',reconciliationOutcome:APPLIED,evidence:reconciliation.evidence};
    const correlationId=execution.batchId||`application-confirmation:${execution.id}`,evidenceRef=decisive.messageId||decisive.url||decisive.applicationId||decisive.source;
    this.registry.recordWorkflowEvent({eventType:'APPLICATION_CONFIRMATION_OBSERVED',aggregateType:'APPLICATION',aggregateId:execution.id,correlationId,occurredAt:decisive.observedAt||this.registry.now(),source:'application_execution',actorType:'EXTERNAL_PLATFORM',payload:{source:decisive.source,provider:decisive.provider||null,evidenceRef},metadata:{refs:{jobId:execution.jobId,applicationId:execution.id}},dedupeKey:`application:${execution.id}:confirmation-observed:${evidenceRef}`});
    this.registry.recordApplicationExecutionStep(execution.id,{stepKey:`confirmation_reconciled:${decisive.source}:${decisive.messageId||decisive.url||decisive.applicationId||'observable'}`,stepType:'application_confirmed',phase:'TERMINAL',evidence:confirmation});
    const handoff=this.registry.getActiveHumanHandoffForExecution(execution.id);if(handoff)this.registry.resolveHumanHandoff(handoff.id,{result:{status:'CONFIRMED_EXTERNALLY',confirmationSource:decisive.source},actorType:'SYSTEM',actorId:'confirmation-reconciler'});
    const applied=this.registry.finishApplicationExecution(execution.id,{status:'APPLIED',stage:'RECONCILIATION',reason:'reconciled_observable_confirmation',confirmation,outreach:{status:'NOT_AUTHORIZED',reason:'application confirmation does not authorize outreach'}});
    this.registry.markCandidateApplied(execution.jobId);
    this.registry.recordWorkflowEvent({eventType:'APPLICATION_MOVED_TO_APPLICATIONS',aggregateType:'APPLICATION',aggregateId:execution.id,correlationId,source:'application_execution',actorType:'SYSTEM',payload:{status:'CONFIRMED_APPLIED'},metadata:{refs:{jobId:execution.jobId,applicationId:execution.id}},dedupeKey:`application:${execution.id}:moved-to-applications`});
    return{status:'RECONCILED',execution:applied,reconciliation};
  }
}

export const APPLICATION_RECONCILIATION_OUTCOMES = Object.freeze({ APPLIED, NOT_APPLIED, UNKNOWN });
