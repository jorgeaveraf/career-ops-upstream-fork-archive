import { buildExecutionPlan } from './planner.mjs';
import { ApplicationExecutionWorker } from './worker.mjs';
import { buildHumanHandoff, parseBundledAnswers } from './human-handoff.mjs';
import { loadCanonicalApplicationAnswers } from './canonical-answers.mjs';
import { resolveApplicationQuestions } from './question-resolver.mjs';

export class ApplicationExecutionService {
  constructor({ registry, executors = {}, clock = () => new Date() } = {}) { if (!registry) throw new TypeError('registry is required'); this.registry = registry; this.executors = executors; this.clock = clock; }
  authorizeImportedActions(applied = []) {
    const authorizations = [], rejected = [];
    for (const action of applied.filter(x => x.entityType === 'JOB' && x.field === 'application_decision' && x.value === 'APPROVE_TO_APPLY')) {
      try {
        const request = this.registry.listEnrichmentRequests({ jobId: action.entityId }).filter(x => x.status === 'READY_FOR_REVIEW').at(-1), job = this.registry.getJob(action.entityId), packageRecord = this.registry.getLatestApplicationPackage(action.entityId), evaluation = this.registry.getLatestJobEvaluation(action.entityId);
        const plan = buildExecutionPlan({ job: { id: job?.id }, request, packageRecord, evaluation, now: this.clock() }); if (plan.status !== 'READY') throw new Error(`execution plan blocked: ${plan.blockers.join(', ')}`);
        const supersedes = this.registry.listApplicationExecutionAuthorizations({ jobId: action.entityId }).filter(value => value.status === 'CANCELLED' && !value.supersededByAuthorizationId).at(-1);
        authorizations.push(this.registry.createApplicationExecutionAuthorization({ jobId: action.entityId, decisionActionId: action.id, executionPlan: plan, authorizationSource: `${action.spreadsheetId}:${action.tabName}`, supersedesAuthorizationId: supersedes?.id || null }));
      } catch (error) { rejected.push({ jobId: action.entityId, actionId: action.id, reason: error.message }); }
    }
    return { authorizations, rejected };
  }
  recordImportedHumanAnswers(applied = []) {
    const recorded = [];
    for (const action of applied.filter(item => item.entityType === 'JOB' && item.field === 'human_answer' && String(item.value || '').trim())) {
      const execution = this.registry.listApplicationExecutions({ jobId: action.entityId, status: 'NEEDS_HUMAN' }).at(-1); if (!execution) continue;
      const handoff=this.registry.getActiveHumanHandoffForExecution(execution.id);
      if(handoff?.questions?.length){const parsed=parseBundledAnswers(action.value,handoff.questions);if(!parsed.ok)continue;for(const answer of parsed.answers)recorded.push(this.registry.recordApplicationHumanAnswer({jobId:action.entityId,executionId:execution.id,question:answer.prompt,normalizedField:answer.fieldKey,answer:answer.answer,scope:answer.persistence==='REUSABLE_GLOBAL'?'GLOBAL':'JOB',sourceActionId:action.id,humanSource:`${action.spreadsheetId}:${action.tabName}`}));this.registry.resolveHumanHandoff(handoff.id,{result:{answerCount:parsed.answers.length},actorType:'HUMAN',actorId:'sheet-user'});continue;}
      const question = String(action.question || execution?.blocker?.question || '').trim(); if (!question) continue;
      const normalizedField = String(action.questionId || question).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); recorded.push(this.registry.recordApplicationHumanAnswer({ jobId: action.entityId, executionId: execution.id, question, normalizedField, answer: action.value, scope: 'JOB', sourceActionId: action.id, humanSource: `${action.spreadsheetId}:${action.tabName}` }));
    }
    return recorded;
  }
  reconcileHumanQuestionHandoffs(){const candidateAnswers=loadCanonicalApplicationAnswers(),changes=[];for(const handoff of this.registry.listHumanHandoffs({status:'ACTIVE'}).filter(item=>['REAL_HUMAN_FACT_REQUIRED','LEGAL_ATTESTATION_REQUIRED'].includes(item.handoffType))){if(handoff.handoffType==='LEGAL_ATTESTATION_REQUIRED')continue;const execution=this.registry.getApplicationExecution(handoff.executionId),humanAnswers=[...this.registry.listApplicationHumanAnswers({jobId:handoff.jobId}),...this.registry.listApplicationHumanAnswers().filter(item=>item.scope==='GLOBAL'&&item.jobId!==handoff.jobId)],answerMemory=this.registry.listApplicationQuestionResolutions?.({reusable:true})||[],sourceFields=handoff.questions.map(item=>({label:item.prompt,name:item.fieldKey,semanticKey:item.fieldKey,type:item.answerType==='NUMBER_OR_RANGE'?'number':'text',required:true,allowedValues:item.allowedValues||[],options:item.allowedValues||[]})),resolution=resolveApplicationQuestions(sourceFields,{candidateAnswers,humanAnswers,answerMemory,jobId:handoff.jobId,now:this.clock()});for(const field of resolution.fields.filter(item=>item.resolved))this.registry.recordApplicationQuestionResolution?.({executionId:execution.id,jobId:handoff.jobId,platformKey:new URL(handoff.openUrl||'https://unknown.invalid').hostname,fieldId:field.semanticKey,question:field.label,semanticKey:field.semanticKey,answer:field.value,resolutionType:field.resolutionType,confidence:field.confidence,evidenceRefs:field.evidenceRefs,scope:field.scope,reusable:field.reusable,validAsOf:this.clock().toISOString().slice(0,10)});const remaining=resolution.fields.filter(item=>!item.resolved);if(remaining.length===handoff.questions.length)continue;if(!remaining.length){this.registry.resolveHumanHandoff(handoff.id,{result:{autoResolved:true,questionResolution:resolution.metrics},actorType:'SYSTEM',actorId:'application-question-resolver'});changes.push({handoffId:handoff.id,previous:handoff.questions.length,current:0,metrics:resolution.metrics});continue;}const model=buildHumanHandoff({execution,type:handoff.handoffType,fields:remaining,blocker:{url:handoff.openUrl,completedFields:resolution.fields.filter(item=>item.resolved).map(item=>item.semanticKey),evidence:{source:'APPLICATION_QUESTION_RESOLVER'}},session:handoff.session,batchId:handoff.batchId});this.registry.createHumanHandoff(model);changes.push({handoffId:handoff.id,previous:handoff.questions.length,current:remaining.length,metrics:resolution.metrics});}return changes;}
  async process({ authorizationId = null, maxApplications = 10, batchId = null } = {}) {
    const reconciledHandoffs=this.reconcileHumanQuestionHandoffs();
    let pending = authorizationId ? [this.registry.getApplicationExecutionAuthorization(authorizationId)].filter(Boolean) : this.registry.listApplicationExecutionAuthorizations({ status: 'APPROVED_TO_APPLY' });
    if (!authorizationId) for (const execution of this.registry.listApplicationExecutions({ status: 'NEEDS_HUMAN' })) { const handoff=this.registry.getActiveHumanHandoffForExecution(execution.id),resolved=this.registry.listHumanHandoffs({jobId:execution.jobId}).some(item=>item.executionId===execution.id&&item.status==='RESOLVED'&&item.resumeStatus!=='RESUMED'),autoResumableTypes=new Set(['INTERACTIVE_CAPTCHA','MFA_REQUIRED','LOGIN_REAUTH_REQUIRED','SECURITY_CHALLENGE']);if(handoff&&autoResumableTypes.has(handoff.handoffType)||resolved){const authorization=this.registry.getApplicationExecutionAuthorization(execution.authorizationId);if(authorization)pending.push(authorization);} }
    pending = [...new Map(pending.map(item => [item.id, item])).values()].slice(0, Math.max(0, Number(maxApplications) || 10));
    const worker = new ApplicationExecutionWorker({ registry: this.registry, executors: this.executors, clock: this.clock }), results = [];
    for (const authorization of pending) results.push(await worker.executeNext({ authorizationId: authorization.id, batchId }));
    return { authorized: pending.length, processed: results.length, results, reconciledHandoffs };
  }
}
