import { existsSync, readFileSync } from 'fs';
import { hashStable } from '../acquisition/normalize.mjs';
import { HUMAN_ONLY_FIELD_PATTERNS } from './contracts.mjs';
import { mayResumeApplicationExecution } from './reconciliation.mjs';
import { buildHumanQuestion } from './human-question.mjs';
import { buildHumanHandoff } from './human-handoff.mjs';
import { loadCanonicalApplicationAnswers } from './canonical-answers.mjs';
import { resolveApplicationQuestions } from './question-resolver.mjs';

const SAFE_PRE_SUBMIT_RECOVERY_CODES = new Set([
  'PLATFORM_RESTRICTION', 'FINAL_SUBMIT_UNAVAILABLE', 'FIELD_WRITE_INCOMPLETE',
  'NAVIGATION_CONTROL_FAILED', 'EXECUTION_ERROR', 'ERR_INVALID_ARG_TYPE',
  'BROWSER_JAVASCRIPT_UNAVAILABLE', 'ACCOUNT_PROVISIONING_UNAVAILABLE',
  'PASSIVE_CHALLENGE_TIMEOUT',
]);

function validateArtifacts(plan, request) {
  for (const name of plan.requiredArtifacts || []) {
    const item = request.artifactManifest?.files?.[name];
    if (!item?.path || !existsSync(item.path)) throw Object.assign(new Error(`approved artifact missing: ${name}`), { code: 'ARTIFACT_MISSING' });
    const observed = hashStable(readFileSync(item.path));
    if (observed !== plan.artifactHashes[name] || observed !== item.hash) throw Object.assign(new Error(`artifact hash mismatch: ${name}`), { code: 'ARTIFACT_HASH_MISMATCH' });
  }
}

const humanQuestions = fields => (fields || []).filter(field =>
  (field.required || HUMAN_ONLY_FIELD_PATTERNS.some(pattern => pattern.test(`${field.label || ''} ${field.name || ''} ${field.context || ''}`))) && !field.canonicalAnswer,
);

const browserHandoffType = code => ({ CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED', MFA_REQUIRED: 'MFA_REQUIRED', LOGIN_REAUTH_REQUIRED: 'LOGIN_REAUTH_REQUIRED', AUTH_REQUIRED: 'LOGIN_REAUTH_REQUIRED', SECURITY_CHALLENGE: 'SECURITY_CHALLENGE', CHALLENGE: 'SECURITY_CHALLENGE', PLATFORM_RESTRICTION: 'PLATFORM_CONFIRMATION_REQUIRED' }[code] || 'SECURITY_CHALLENGE');

export class ApplicationExecutionWorker {
  constructor({ registry, executors = {}, clock = () => new Date() } = {}) {
    if (!registry) throw new TypeError('registry is required');
    this.registry = registry; this.executors = executors; this.clock = clock;
  }

  async pauseForHuman({ executor, execution, type, fields = [], blocker = {}, batchId = null, stage = 'FORM_FIELDS' }) {
    const session = await executor.pause?.({ execution }).catch(() => ({})) || {};
    const model = buildHumanHandoff({ execution: this.registry.getApplicationExecution(execution.id) || execution, type, fields, blocker, session, batchId });
    const handoff = this.registry.createHumanHandoff(model);
    const paused = this.registry.finishApplicationExecution(execution.id, { status: 'NEEDS_HUMAN', stage, reason: type, blocker: { ...blocker, code: type, handoffId: handoff.id, handoffType: type, action: handoff.action, instruction: handoff.instruction, requiredQuestions: handoff.questions, question: handoff.questions[0]?.prompt || blocker.question, url: handoff.openUrl, sessionResumable: Boolean(session.windowId && session.tabId && session.markerUrl) } });
    return { ...paused, executionState: 'PAUSED_FOR_HUMAN', handoff };
  }

  async executeNext({ authorizationId = null, batchId = null } = {}) {
    let authorization = authorizationId
      ? this.registry.getApplicationExecutionAuthorization(authorizationId)
      : this.registry.listApplicationExecutionAuthorizations({ status: 'APPROVED_TO_APPLY' })[0];
    if (!authorization) return { status: 'NO_WORK', externalMutations: 0 };
    let existing = this.registry.getApplicationExecutionByAuthorization(authorization.id);
    if (existing?.status === 'APPLIED') return { status: 'APPLIED', reused: true, execution: existing, externalMutations: 0 };
    if(existing?.status==='NEEDS_HUMAN'&&!this.registry.getActiveHumanHandoffForExecution?.(existing.id)&&existing.mutationState==='PRE_SUBMIT'){const legacyCode=existing.blocker?.code,type=legacyCode==='REAL_HUMAN_FACT_REQUIRED'?'REAL_HUMAN_FACT_REQUIRED':legacyCode==='LEGAL_ATTESTATION_REQUIRED'?'LEGAL_ATTESTATION_REQUIRED':/CAPTCHA|MFA|LOGIN|AUTH|CHALLENGE|PLATFORM_RESTRICTION/.test(String(legacyCode||''))?browserHandoffType(legacyCode):null;if(type)this.registry.createHumanHandoff?.(buildHumanHandoff({execution:existing,type,blocker:existing.blocker,session:existing.sessionContext?.handoffSession||{},batchId:batchId||existing.batchId}));}
    if (existing?.status === 'NEEDS_HUMAN' && existing?.blocker?.code === 'VERIFICATION_UNKNOWN' && !mayResumeApplicationExecution(existing)) {
      return { status: 'BLOCKED', reason: 'application verification is ambiguous; automatic retry forbidden', authorizationId: authorization.id, execution: existing, externalMutations: 0 };
    }
    const activeHandoff = existing ? this.registry.getActiveHumanHandoffForExecution?.(existing.id) : null;
    const resolvedHandoff = existing ? (this.registry.listHumanHandoffs?.({ jobId: existing.jobId })||[]).filter(item => item.executionId === existing.id && item.status === 'RESOLVED' && item.resumeStatus !== 'RESUMED').at(-1) : null;
    const handoffRecovery = existing?.mutationState === 'PRE_SUBMIT' && Boolean(activeHandoff || resolvedHandoff);
    const safeRecovery = existing?.mutationState === 'PRE_SUBMIT'
      && ['FAILED', 'NEEDS_HUMAN'].includes(existing.status)
      && SAFE_PRE_SUBMIT_RECOVERY_CODES.has(existing.blocker?.code);
    if (safeRecovery || handoffRecovery) { const handoff=activeHandoff||resolvedHandoff;if(handoff)this.registry.startHumanHandoffResume(handoff.id); existing = this.registry.resumePreSubmitApplicationExecution(existing.id, { batchId, reason: handoffRecovery ? 'automatic human handoff resume' : `safe recovery after ${existing.blocker?.code}` }); authorization = this.registry.getApplicationExecutionAuthorization(authorization.id); }
    if (!safeRecovery && !handoffRecovery && !['APPROVED_TO_APPLY', 'EXECUTING', 'NEEDS_HUMAN'].includes(authorization.status)) {
      return { status: 'BLOCKED', reason: 'authorization is not current', authorizationId: authorization.id, externalMutations: 0 };
    }

    const request = this.registry.getEnrichmentRequest(authorization.enrichmentRequestId), plan = authorization.executionPlan;
    const nativeExecutor = this.executors[plan.primaryChannel], genericExecutor = this.executors.GENERIC_BROWSER;
    let executor = plan.executionMode === 'GENERIC_BROWSER' || (!plan.executionMode && ['PLATFORM', 'MANUAL_EXTERNAL'].includes(plan.primaryChannel)) ? genericExecutor : (nativeExecutor || genericExecutor);
    const executionMode = executor === nativeExecutor && nativeExecutor ? 'NATIVE' : 'GENERIC_BROWSER';
    const execution = safeRecovery || handoffRecovery ? existing : this.registry.beginApplicationExecution(authorization.id, { executionMode, batchId });
    const humanAnswers = [...this.registry.listApplicationHumanAnswers({ jobId: authorization.jobId }), ...this.registry.listApplicationHumanAnswers().filter(item => item.scope === 'GLOBAL' && item.jobId !== authorization.jobId)];
    try {
      validateArtifacts(plan, request);
      if (!executor) return this.registry.finishApplicationExecution(execution.id, { status: 'FAILED', stage: 'PREFLIGHT', reason: 'no viable native or generic browser strategy', blocker: { code: 'EXECUTION_STRATEGY_UNAVAILABLE' } });
      let inspection = await executor.inspect({ plan, request: { ...request, humanAnswers }, execution, authorization });
      if (inspection?.outcome === 'UNSUPPORTED' && executor === nativeExecutor && genericExecutor && genericExecutor !== nativeExecutor) {
        await executor.stop?.({ execution, authorization }); executor = genericExecutor;
        inspection = await executor.inspect({ plan, request: { ...request, humanAnswers }, execution, authorization });
      }
      if (['AUTH_REQUIRED', 'CHALLENGE', 'CAPTCHA', 'SECURITY_BOUNDARY', 'PLATFORM_RESTRICTION'].includes(inspection?.outcome)) {
        const code = inspection.securityCode || ({ AUTH_REQUIRED: 'LOGIN_REAUTH_REQUIRED', CHALLENGE: 'SECURITY_CHALLENGE', CAPTCHA: 'CAPTCHA_REQUIRED', PLATFORM_RESTRICTION: 'PLATFORM_RESTRICTION' }[inspection.outcome] || 'SECURITY_CHALLENGE');
        const type=browserHandoffType(code); if(activeHandoff)this.registry.finishHumanHandoffResume(activeHandoff.id,{status:'PAUSED_FOR_HUMAN',result:{boundary:type}});
        return this.pauseForHuman({ executor, execution, type, batchId, stage: 'PREFLIGHT', blocker: { classification: 'BLOCKED_EXTERNAL_SECURITY', url: inspection.url || plan.primaryTarget } });
      }
      if(inspection?.outcome==='TECHNICAL_BLOCKER'){await executor.stop?.({execution,authorization});return this.registry.finishApplicationExecution(execution.id,{status:'FAILED',stage:'PREFLIGHT',reason:inspection.securityCode||'PASSIVE_CHALLENGE_TIMEOUT',blocker:{code:inspection.securityCode||'PASSIVE_CHALLENGE_TIMEOUT',classification:'TECHNICAL_RECOVERY',url:inspection.url||plan.primaryTarget}});}
      // Native executors do not own the semantic fill loop. Resolve their
      // inspected fields here and stop before submit only for irreducible facts.
      if (executor !== genericExecutor && inspection?.fields?.length) {
        const questionResolution = resolveApplicationQuestions(inspection.fields, { candidateAnswers: loadCanonicalApplicationAnswers(), plan, humanAnswers, answerMemory: this.registry.listApplicationQuestionResolutions?.({ reusable: true }) || [], jobId: authorization.jobId, now: this.clock() });
        inspection = { ...inspection, fields: questionResolution.fields, questionResolution: questionResolution.metrics };
        const unresolved = humanQuestions(questionResolution.fields);
        if (unresolved.length) {
          const contracts = unresolved.map(question => buildHumanQuestion({ jobId: authorization.jobId, executionId: execution.id, field: question, workId: `application:${authorization.id}` }));
          return this.pauseForHuman({ executor, execution, type: 'REAL_HUMAN_FACT_REQUIRED', fields: contracts.map((contract, index) => ({ ...unresolved[index], questionId: contract.question_id, prompt: contract.prompt })), blocker: { classification: 'IRREDUCIBLE_APPLICATION_QUESTIONS', url: inspection.url || plan.primaryTarget, requiredQuestions: unresolved }, batchId, stage: 'FORM_FIELDS' });
        }
      }
      const result = await executor.submit({ plan, request: { ...request, humanAnswers }, inspection, execution, authorization });
      if (!result?.confirmed && result?.needsHuman) { const type=result.reason==='LEGAL_ATTESTATION_REQUIRED'?'LEGAL_ATTESTATION_REQUIRED':result.reason==='REAL_HUMAN_FACT_REQUIRED'?'REAL_HUMAN_FACT_REQUIRED':browserHandoffType(result.reason),prior=activeHandoff||resolvedHandoff;if(prior&&prior.handoffType!==type){if(activeHandoff)this.registry.resolveHumanHandoff(prior.id,{result:{detectedAutomatically:true},actorType:'SYSTEM',actorId:'resume-detector'});this.registry.finishHumanHandoffResume(prior.id,{status:'RESUMED',result:{status:'CONTINUED_TO_NEW_BOUNDARY',boundary:type}});}const questions=humanQuestions(result.blocker?.requiredQuestions||[]),contracts=questions.map(question=>buildHumanQuestion({jobId:authorization.jobId,executionId:execution.id,field:question,workId:`application:${authorization.id}`}));return this.pauseForHuman({executor,execution,type,fields:contracts.map((contract,index)=>({...questions[index],questionId:contract.question_id,prompt:contract.prompt})),blocker:result.blocker||{},batchId,stage:'CONFIRMATION'}); }
      if (!result?.confirmed) { const prior=activeHandoff||resolvedHandoff;if(prior){if(activeHandoff)this.registry.resolveHumanHandoff(prior.id,{result:{resumeFailed:true},actorType:'SYSTEM',actorId:'application-worker'});this.registry.finishHumanHandoffResume(prior.id,{status:'FAILED',result:{status:result?.reason||'FAILED'}});}await executor.stop?.({execution,authorization}); return this.registry.finishApplicationExecution(execution.id, { status: 'FAILED', stage: 'CONFIRMATION', reason: result?.reason || 'observable confirmation missing', blocker: result?.blocker || {}, confirmation: result?.confirmation || {} }); }
      await executor.stop?.({execution,authorization});
      {const prior=activeHandoff||resolvedHandoff;if(prior){if(activeHandoff)this.registry.resolveHumanHandoff(prior.id,{result:{detectedAutomatically:true},actorType:'SYSTEM',actorId:'resume-detector'});this.registry.finishHumanHandoffResume(prior.id,{status:'RESUMED',result:{status:'CONTINUED_AND_CONFIRMED'}});}}
      const applied = this.registry.finishApplicationExecution(execution.id, { status: 'APPLIED', stage: 'CONFIRMED', reason: 'observable primary application confirmation', confirmation: result.confirmation, outreach: { status: 'NOT_AUTHORIZED', reason: 'APPROVE_TO_APPLY never authorizes outreach' } });
      this.registry.markCandidateApplied?.(authorization.jobId); return applied;
    } catch (error) {
      await executor?.stop?.({ execution, authorization }).catch(()=>{});
      if(error?.code==='BROWSER_SESSION_LOCKED'&&activeHandoff){this.registry.finishHumanHandoffResume(activeHandoff.id,{status:'PAUSED_FOR_HUMAN',result:{status:'WAITING_FOR_WORKER_LOCK'}});const paused=this.registry.finishApplicationExecution(execution.id,{status:'NEEDS_HUMAN',stage:'PREFLIGHT',reason:activeHandoff.handoffType,blocker:{code:activeHandoff.handoffType,handoffId:activeHandoff.id,handoffType:activeHandoff.handoffType,action:activeHandoff.action,instruction:activeHandoff.instruction,url:activeHandoff.openUrl,requiredQuestions:activeHandoff.questions,sessionResumable:Boolean(activeHandoff.session?.windowId)}});return{...paused,executionState:'PAUSED_FOR_HUMAN',handoff:activeHandoff};}
      {const prior=activeHandoff||resolvedHandoff;if(prior){if(activeHandoff)this.registry.resolveHumanHandoff(prior.id,{result:{resumeFailed:true},actorType:'SYSTEM',actorId:'application-worker'});this.registry.finishHumanHandoffResume(prior.id,{status:'FAILED',result:{status:'EXECUTION_ERROR',message:error.message}});}}
      return this.registry.finishApplicationExecution(execution.id, { status: 'FAILED', stage: 'EXECUTION', reason: error.message, blocker: { code: error.code || 'EXECUTION_ERROR' } });
    }
  }
}
