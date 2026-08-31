import { loadIdentityRouting, resolveIdentityForPurpose } from '../operations/identity-routing.mjs';
import { CANDIDATE_GMAIL_SENDER, OUTREACH_LIMITS } from '../outreach-execution/contracts.mjs';
import { isDue, scheduleForPlan } from '../outreach-execution/scheduler.mjs';

function applicationConfirmed(registry, jobId) {
  if (registry.listApplicationExecutions({ jobId, status: 'APPLIED' }).length) return true;
  return registry.getHumanFieldState().some(item => item.entityType === 'JOB' && item.entityId === jobId
    && item.field === 'human_resolution' && item.value === 'CONFIRMED_APPLIED');
}
function localDate(value){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
function providerFor(channel){return channel==='LINKEDIN_PROFILE'?'linkedin':['RECRUITER_EMAIL','HIRING_MANAGER_EMAIL','GENERAL_RECRUITING'].includes(channel)?'gmail':'manual';}

export class OutreachExecutionService {
  constructor({ registry, executors = {}, profilePath = 'config/profile.yml', clock=()=>new Date(), limits=OUTREACH_LIMITS } = {}) {
    if (!registry) throw new TypeError('registry is required');
    this.registry = registry; this.executors = executors; this.profilePath = profilePath; this.clock=clock; this.limits=limits;
  }
  authorizeImportedActions(applied = []) {
    const authorizations = [], rejected = [];
    for (const action of applied.filter(item => item.entityType === 'JOB' && item.field === 'outreach_decision' && item.value === 'APPROVE_OUTREACH')) {
      try {
        const request = this.registry.listEnrichmentRequests({ jobId: action.entityId }).filter(item => item.status === 'READY_FOR_REVIEW').at(-1);
        authorizations.push(this.registry.createOutreachAuthorization({ jobId: action.entityId, decisionActionId: action.id,
          outreachPlan: request?.applicationPlan?.activation?.outreachPlan,
          authorizationSource: `${action.spreadsheetId}:${action.tabName}` }));
      } catch (error) { rejected.push({ jobId: action.entityId, actionId: action.id, reason: error.message }); }
    }
    return { authorizations, rejected };
  }
  schedule(authorization){
    const scheduledAt=scheduleForPlan(authorization.outreachPlan,{now:this.clock(),applicationConfirmed:applicationConfirmed(this.registry,authorization.jobId)});
    if(!scheduledAt)return{status:'WAITING_FOR_APPLICATION',authorization};
    const updated=this.registry.scheduleOutreachAuthorization?.(authorization.id,scheduledAt)||{...authorization,scheduledAt};
    return{status:isDue(scheduledAt,this.clock())?'AUTHORIZED':'SCHEDULED',authorization:updated};
  }
  schedulePending(){return this.registry.listOutreachAuthorizations({status:'APPROVED_OUTREACH'}).map(item=>item.scheduledAt?{status:isDue(item.scheduledAt,this.clock())?'AUTHORIZED':'SCHEDULED',authorization:item}:this.schedule(item));}
  currentPlanMatches(authorization){if(!this.registry.listEnrichmentRequests)return true;const latest=this.registry.listEnrichmentRequests({jobId:authorization.jobId}).filter(x=>x.status==='READY_FOR_REVIEW').at(-1);return latest?.id===authorization.enrichmentRequestId&&latest.applicationPlan?.activation?.outreachPlan?.hash===authorization.outreachPlanHash;}
  withinRateLimit(channel){const today=localDate(this.clock());const provider=providerFor(channel);const count=(this.registry.listOutreachExecutions?.({status:'SENT'})||[]).filter(x=>providerFor(x.channel)===provider&&x.sentAt&&localDate(x.sentAt)===today).length;const limit=provider==='linkedin'?this.limits.linkedinPerDay:this.limits.emailPerDay;return{allowed:count<limit,count,limit};}
  async execute({ authorizationId } = {}) {
    const authorization = this.registry.getOutreachAuthorization(authorizationId);
    if (!authorization) return { status: 'NO_WORK', externalMutations: 0 };
    const existing = this.registry.getOutreachExecutionByAuthorization(authorization.id);
    if (existing?.status === 'SENT') return { status: 'SENT', reused: true, execution: existing, externalMutations: 0 };
    if (existing?.status === 'VERIFICATION_REQUIRED') return { status: 'VERIFICATION_REQUIRED', reused: true, execution: existing, externalMutations: 0 };
    if (existing?.status === 'NEEDS_HUMAN') return { status: 'NEEDS_HUMAN', reused: true, execution: existing, externalMutations: 0 };
    if (authorization.status !== 'APPROVED_OUTREACH') return { status: 'BLOCKED', reason: 'outreach authorization is not current', externalMutations: 0 };
    if(!this.currentPlanMatches(authorization))return{status:'BLOCKED',reason:'outreach authorization is stale because the exact plan changed',externalMutations:0};
    const plan = authorization.outreachPlan;
    const scheduled=authorization.scheduledAt?authorization:this.schedule(authorization).authorization;
    if(!scheduled?.scheduledAt)return { status: 'WAITING_FOR_APPLICATION', reason: 'APPLICATION_CONFIRMED is required before outreach', externalMutations: 0 };
    if(!isDue(scheduled.scheduledAt,this.clock()))return{status:'SCHEDULED',scheduledAt:scheduled.scheduledAt,externalMutations:0};
    if (['IMMEDIATELY_AFTER_APPLICATION', 'NEXT_BUSINESS_DAY', 'FOLLOW_UP_AFTER_N_DAYS'].includes(plan.timing)
      && !applicationConfirmed(this.registry, authorization.jobId)) return { status: 'WAITING_FOR_APPLICATION', reason: 'APPLICATION_CONFIRMED is required before outreach', externalMutations: 0 };
    const route = resolveIdentityForPurpose(loadIdentityRouting({ profilePath: this.profilePath }), 'JUSTIFIED_RECRUITER_HIRING_OUTREACH');
    if (route.channel !== 'APPLICATION_EMAIL' || String(route.sender).toLowerCase() !== CANDIDATE_GMAIL_SENDER) return { status: 'BLOCKED', reason: 'candidate outreach sender did not resolve exactly', externalMutations: 0 };
    const rate=this.withinRateLimit(plan.channel);if(!rate.allowed)return{status:'SCHEDULED',reason:`${providerFor(plan.channel)} daily safety ceiling reached`,scheduledAt:scheduled.scheduledAt,externalMutations:0};
    const executor = this.executors[plan.channel];
    if (!executor || (plan.channel==='GENERAL_RECRUITING'&&!plan.recipient)) {
      const execution=this.registry.beginOutreachExecution(authorization.id,{sender:route.sender,provider:'manual'});
      return this.registry.finishOutreachExecution(execution.id, { status: 'NEEDS_HUMAN', blocker: { code: 'EXTERNAL_ACTION_REQUIRED', channel: plan.channel, target: plan.publicUrl||'', suggestedMessage:plan.body, reason:!executor?'TRANSPORT_UNAVAILABLE':'PUBLIC_ROUTE_IS_NOT_EMAIL' } });
    }
    const execution = this.registry.beginOutreachExecution(authorization.id, { sender: route.sender,provider:providerFor(plan.channel) });
    try {
      const result = await executor.sendOnce({ plan, authorization, execution, sender: route.sender });
      if(result?.externalActionRequired)return this.registry.finishOutreachExecution(execution.id,{status:'NEEDS_HUMAN',blocker:{code:'EXTERNAL_ACTION_REQUIRED',reason:result.reason,url:result.url||plan.publicUrl||'',channel:plan.channel}});
      if (result?.confirmed && (result.messageId || result.id || result.url)) return this.registry.finishOutreachExecution(execution.id, { status: 'SENT', confirmation: result });
      return this.registry.finishOutreachExecution(execution.id, { status: 'VERIFICATION_REQUIRED', blocker: { code: 'SEND_AMBIGUOUS', reason: result?.reason || 'Observable send confirmation is missing; automatic retry is forbidden.' } });
    } catch (error) {
      return this.registry.finishOutreachExecution(execution.id, { status: error?.ambiguous ? 'VERIFICATION_REQUIRED' : 'FAILED', blocker: { code: error.code || 'OUTREACH_SEND_FAILED', reason: error.message } });
    }
  }
  async process({max=this.limits.perRun}={}){const scheduled=this.schedulePending();const due=this.registry.listDueOutreachAuthorizations?this.registry.listDueOutreachAuthorizations({at:this.clock(),limit:Math.min(max,this.limits.perRun)}):scheduled.filter(x=>x.status==='AUTHORIZED').map(x=>x.authorization);const results=[];for(const authorization of due)results.push(await this.execute({authorizationId:authorization.id}));return{scheduled,results,processed:results.length,sent:results.filter(x=>x.status==='SENT').length};}
  async checkResponses(){const results=[];for(const execution of this.registry.listOutreachExecutions({status:'SENT'})){if(execution.responseAt)continue;const executor=this.executors[execution.channel];if(!executor?.checkResponse)continue;const result=await executor.checkResponse({threadId:execution.providerThreadId,recipient:execution.recipient,conversationUrl:execution.conversationUrl});if(result.status==='RESPONSE_RECEIVED')results.push(this.registry.recordOutreachResponse(execution.id,{responseAt:result.responseAt,providerMessageId:result.messageId,outcome:'REPLIED'}));}return results;}
}
