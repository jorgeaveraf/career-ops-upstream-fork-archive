import { hashStable } from '../acquisition/normalize.mjs';
import { validateApplicationReadiness } from '../application-enrichment/readiness.mjs';
import { ATTENTION_ORDER, ATTENTION_TYPES, HUMAN_INPUT_ERROR, VERIFICATION_RESOLUTIONS } from './contracts.mjs';
import { selectTodayMembership } from '../human-control-plane/today-membership.mjs';
import { isStructuredHumanQuestion } from '../application-execution/human-question.mjs';
import { formatQuestionBundle } from '../application-execution/human-handoff.mjs';

const text = value => String(value ?? '').trim();
const upper = value => text(value).toUpperCase();
const stateMap = states => new Map((states || []).map(item => [`${item.entityType}:${item.entityId}:${item.field}`, item]));
const field = (states, type, id, name, fallback = '') => states.get(`${type}:${id}:${name}`)?.value ?? fallback;
const byJob = items => new Map((items || []).map(item => [item.jobId, item]));
const latestSourceEvent = (data, jobId, types) => (data.recentWorkflowEvents || []).filter(item => item.refs?.jobId === jobId && types.includes(item.eventType)).at(-1) || null;
const safeExternal = code => /CAPTCHA|CHALLENGE|MFA|AUTH|LOGIN/i.test(text(code));

function item(input) {
  const attentionType = upper(input.attentionType);
  if (!ATTENTION_TYPES.includes(attentionType)) throw new TypeError(`unknown attention type: ${attentionType}`);
  const entityType = upper(input.entityType || 'JOB');
  const entityId = text(input.entityId || input.jobId);
  const questionId = text(input.questionId);
  return Object.freeze({
    attentionId: hashStable(`${attentionType}:${entityType}:${entityId}:${questionId || 'primary'}`),
    attentionType, entityType, entityId, jobId: entityType === 'JOB' ? entityId : null,
    company: text(input.company), role: text(input.role), stage: text(input.stage),
    workflowStatus: text(input.workflowStatus || 'WAITING_FOR_HUMAN'), priority: ['CAPTCHA_REQUIRED','MFA_REQUIRED'].includes(upper(input.handoffType)) ? 'CRITICAL' : upper(input.priority || 'NORMAL'),
    reason: text(input.reason), question: text(input.question), questionId,
    currentAnswer: text(input.currentAnswer), recommendedAction: text(input.recommendedAction),
    allowedActions: Object.freeze([...(input.allowedActions || [])]), createdAt: text(input.createdAt),
    lastUpdatedAt: text(input.lastUpdatedAt || input.createdAt), sourceEventId: input.sourceEventId || null,
    correlationId: input.correlationId || null, externalActionRequired: Boolean(input.externalActionRequired),
    inputError: text(input.inputError), platform: text(input.platform), handoffId:text(input.handoffId),handoffType:text(input.handoffType),instruction:text(input.instruction),openUrl:text(input.openUrl),questionBundle:text(input.questionBundle),applicationProgress:text(input.applicationProgress),questionCount:Number(input.questionCount||0),sessionResumable:Boolean(input.sessionResumable),
  });
}

function rejectedResolutionErrors(data) {
  const errors = new Map();
  for (const action of data.rejectedHumanActions || []) {
    if (action.tabName === 'TODAY' && action.field === 'Human Resolution' && action.status === 'REJECTED') {
      if (!errors.has(action.entityId)) errors.set(action.entityId, HUMAN_INPUT_ERROR.human_resolution);
    }
  }
  return errors;
}

export function deriveHumanAttentionItems(data = {}, { now = new Date() } = {}) {
  const states = stateMap(data.humanState); const jobs = new Map((data.jobs || []).map(value => [value.job.id, value]));
  const executions = byJob(data.applicationExecutions); const enrichments = byJob(data.enrichmentRequests);
  const workflows = byJob(data.workflowStatuses); const errors = rejectedResolutionErrors(data); const items = [];const handoffs=new Map((data.humanHandoffs||[]).filter(value=>value.status==='ACTIVE').map(value=>[value.executionId,value]));

  for (const [jobId, execution] of executions) {
    if (execution.status !== 'NEEDS_HUMAN') continue;
    const job = jobs.get(jobId)?.job || {}; const workflow = workflows.get(jobId) || {}; const code = upper(execution.blocker?.code);
    const event = latestSourceEvent(data, jobId, ['APPLICATION_VERIFICATION_UNKNOWN', 'APPLICATION_NEEDS_HUMAN']);
    const handoff=handoffs.get(execution.id);if(handoff){const fact=['REAL_HUMAN_FACT_REQUIRED','LEGAL_ATTESTATION_REQUIRED'].includes(handoff.handoffType),bundle=formatQuestionBundle(handoff.questions);items.push(item({attentionType:fact?'ANSWER_REQUIRED':'EXTERNAL_ACTION_REQUIRED',jobId,company:job.company,role:job.title,stage:'APPLY',priority:'HIGH',reason:handoff.instruction,question:fact?bundle:'',questionId:handoff.id,currentAnswer:fact?field(states,'JOB',jobId,'human_answer',''):'',recommendedAction:handoff.action,allowedActions:fact?['PROVIDE_ANSWER']:[],externalActionRequired:!fact,platform:execution.primaryChannel,createdAt:handoff.createdAt,lastUpdatedAt:handoff.updatedAt,sourceEventId:event?.eventId,correlationId:event?.correlationId,handoffId:handoff.id,handoffType:handoff.handoffType,instruction:handoff.instruction,openUrl:handoff.openUrl,questionBundle:bundle,applicationProgress:handoff.progress,questionCount:handoff.questions.length,sessionResumable:Boolean(handoff.session?.windowId&&handoff.session?.tabId&&handoff.session?.markerUrl)}));continue;}
    if (code === 'VERIFICATION_UNKNOWN') {
      items.push(item({ attentionType:'VERIFICATION_REQUIRED', jobId, company:job.company, role:job.title, stage:'APPLY',
        priority:'CRITICAL', reason:'El resultado del envío no pudo verificarse con certeza.',
        question:'¿La aplicación fue enviada?', allowedActions:VERIFICATION_RESOLUTIONS,
        recommendedAction:'Verifica el ATS o el correo; elige una resolución. No reintentes el envío.',
        createdAt:execution.updatedAt || execution.createdAt, lastUpdatedAt:workflow.lastUpdated,
        sourceEventId:event?.eventId, correlationId:event?.correlationId, inputError:errors.get(jobId) || '' }));
      continue;
    }
    if (safeExternal(code)) {
      items.push(item({ attentionType:'EXTERNAL_ACTION_REQUIRED', jobId, company:job.company, role:job.title, stage:'APPLY',
        priority:'HIGH', reason:execution.blocker?.question || code, question:execution.blocker?.question,
        recommendedAction:'Completa la autenticación o challenge en la plataforma y después usa Sync Jobs.',
        allowedActions:[], externalActionRequired:true, platform:execution.primaryChannel,
        createdAt:execution.updatedAt || execution.createdAt, lastUpdatedAt:workflow.lastUpdated,
        sourceEventId:event?.eventId, correlationId:event?.correlationId }));
      continue;
    }
    if(code==='EXTERNAL_ACTION_REQUIRED'){
      items.push(item({attentionType:'EXTERNAL_ACTION_REQUIRED',jobId,company:job.company,role:job.title,stage:'APPLY',priority:'HIGH',reason:execution.blocker?.instruction||'The approved route requires a manual action on the external platform.',question:'',recommendedAction:execution.blocker?.instruction||'Open the exact link, complete the application manually, then record the outcome and use Sync Jobs.',allowedActions:[],externalActionRequired:true,platform:execution.primaryChannel,createdAt:execution.updatedAt||execution.createdAt,lastUpdatedAt:workflow.lastUpdated,sourceEventId:event?.eventId,correlationId:event?.correlationId}));continue;
    }
    if(code==='EXECUTOR_UNAVAILABLE'||/^(EXECUTION_ERROR|WORKER_|TRANSPORT_)/.test(code))continue;
    const structured=isStructuredHumanQuestion(execution.blocker?.humanQuestion),legacyQuestions=Array.isArray(execution.blocker?.questions)&&execution.blocker.questions.length?execution.blocker.questions:execution.blocker?.question?[{question:execution.blocker.question,questionId:execution.blocker.questionId,field:execution.blocker.field,reason:execution.blocker.reason}]:[];
    if(!structured&&!legacyQuestions.length)continue;
    const questions = structured
      ? [{ question:execution.blocker.humanQuestion.prompt, questionId:execution.blocker.humanQuestion.question_id, field:execution.blocker.humanQuestion.field_key, reason:execution.blocker.humanQuestion.help_text }]
      : legacyQuestions.filter(entry=>!/password|contrase(?:n|ñ)a|mfa|2fa|otp|token|cookie|secret|c[oó]digo de verificaci[oó]n/i.test(`${entry.question||''} ${entry.field||''}`));
    for (const entry of questions) {
      const question = text(entry?.question || entry?.label || code || 'Career Ops necesita una respuesta para continuar.');
      const questionId = text(entry?.questionId || entry?.field || hashStable(question));
      const priorAnswer=(data.applicationHumanAnswers||[]).find(answer=>answer.jobId===jobId&&(answer.normalizedField===questionId||answer.question===question));
      items.push(item({ attentionType:'ANSWER_REQUIRED', jobId, company:job.company, role:job.title, stage:'APPLY', priority:'HIGH',
        reason:entry?.reason || execution.blocker?.reason || 'Falta información personal que Career Ops no debe inferir.', question, questionId,
        currentAnswer:text(priorAnswer?.answer ?? field(states,'JOB',jobId,'human_answer','')), allowedActions:['PROVIDE_ANSWER'],
        recommendedAction:'Escribe Human Answer y usa Sync Jobs. Nunca pongas contraseñas, códigos MFA o tokens.',
        createdAt:execution.updatedAt || execution.createdAt, lastUpdatedAt:workflow.lastUpdated,
        sourceEventId:event?.eventId, correlationId:event?.correlationId }));
    }
  }

  for (const [jobId, enrichment] of enrichments) {
    if (enrichment.status !== 'READY_FOR_REVIEW' || executions.get(jobId)?.status === 'NEEDS_HUMAN') continue;
    const decision = upper(field(states,'JOB',jobId,'application_decision','NO_ACTION')) || 'NO_ACTION';
    if (['APPROVE_TO_APPLY','REJECT'].includes(decision)) continue;
    const jobItem=jobs.get(jobId)||{};const job = jobItem.job || {}; const event = latestSourceEvent(data,jobId,['ENRICHMENT_COMPLETED']);
    const readiness=validateApplicationReadiness({evaluation:jobItem.evaluation,applicationPlan:enrichment.applicationPlan,applicationPackage:jobItem.applicationPackage,latestApplicationPackage:jobItem.applicationPackage,artifactManifest:enrichment.artifactManifest,completion:enrichment.enrichmentCompletion,packageState:enrichment.packageState,blockers:enrichment.lastErrorCode?[enrichment.lastErrorCode]:[]});
    if(!readiness.ready)continue;
    const reauthorization=decision==='HOLD'&&executions.get(jobId)?.status==='CANCELLED';if(decision==='HOLD'&&!reauthorization)continue;
    const applyRecommended=readiness.recommendation==='APPLY';
    items.push(item({ attentionType:reauthorization?'APPROVAL_REQUIRED':'REVIEW_REQUIRED', jobId, company:job.company, role:job.title, stage:reauthorization?'APPLY':'PREPARE', priority:applyRecommended?'HIGH':'LOW',
      reason:reauthorization?'La ejecución ambigua se cerró como NOT_APPLIED; sólo una nueva autorización exacta puede continuar.':readiness.recommendation==='APPLY'?'La preparación requerida está completa y verificada.':'La evaluación está completa; no se generó un paquete porque la recomendación no es APPLY.', question:readiness.recommendation==='APPLY'?'Revisa evaluación, gaps, plan y artefactos.':'Revisa la evaluación y decide si cerrar, conservar o continuar.',
      allowedActions:applyRecommended?['APPROVE_TO_APPLY','HOLD','REJECT']:['REJECT','HOLD','NEXT_STAGE'], recommendedAction:applyRecommended?'Abre los artefactos del paquete; decide en Application Decision y usa Sync Jobs.':'No hay paquete aprobable. Revisa la evaluación; conserva NEXT_STAGE, cambia a HOLD o REJECT.',
      createdAt:enrichment.updatedAt || enrichment.requestedAt, lastUpdatedAt:enrichment.updatedAt,
      sourceEventId:event?.eventId, correlationId:event?.correlationId }));
  }

  const topIds = new Set(selectTodayMembership(data).curatedJobIds);
  for (const jobId of topIds) {
    if ([...items].some(value => value.jobId === jobId)) continue;
    if (executions.get(jobId)?.status === 'APPLIED') continue;
    const decision = upper(field(states,'JOB',jobId,'human_decision','NO_ACTION')) || 'NO_ACTION';
    if (decision !== 'NO_ACTION') continue;
    const job = jobs.get(jobId)?.job || {}; const workflow=workflows.get(jobId)||{};
    items.push(item({attentionType:'DECISION_REQUIRED',jobId,company:job.company,role:job.title,stage:'DECIDE',priority:'NORMAL',
      reason:'Oportunidad priorizada sin decisión humana.',question:'¿Quieres descartar, conservar o preparar esta oportunidad?',
      allowedActions:['REJECT','HOLD','NEXT_STAGE'],recommendedAction:'Elige Human Decision y usa Sync Jobs.',
      createdAt:job.lastSeenAt,lastUpdatedAt:workflow.lastUpdated}));
  }

  for (const application of data.applicationExecutions || []) {
    if (application.status !== 'APPLIED') continue;
    const jobId=application.jobId, followDate=text(field(states,'JOB',jobId,'follow_up_date',''));
    const followAction=text(field(states,'JOB',jobId,'follow_up_action',''));
    if (!followAction || (followDate && new Date(`${followDate}T23:59:59`).getTime() > now.getTime())) continue;
    const job=jobs.get(jobId)?.job||{};
    items.push(item({attentionType:'FOLLOW_UP_REQUIRED',jobId,company:job.company,role:job.title,stage:'TRACK_LEARN',priority:'NORMAL',
      reason:followDate?`Seguimiento programado para ${followDate}.`:'Hay una acción de seguimiento pendiente.',question:followAction,
      allowedActions:['UPDATE_FOLLOW_UP','MARK_DONE'],recommendedAction:'Actualiza la fecha/acción/outcome en APPLICATIONS o FOLLOW_UPS y usa Sync Jobs.',
      createdAt:application.finishedAt,lastUpdatedAt:application.updatedAt}));
  }

  for (const community of data.communities || []) {
    if (!['NEEDS_HUMAN','CHALLENGE','AUTH_REQUIRED','VERIFICATION_UNKNOWN'].includes(upper(community.membershipState))) continue;
    const external = safeExternal(community.membershipState) || community.membershipState === 'VERIFICATION_UNKNOWN';
    items.push(item({attentionType:external?'EXTERNAL_ACTION_REQUIRED':'ANSWER_REQUIRED',entityType:'COMMUNITY',entityId:community.id,
      company:community.name,role:'Community join',stage:'COMMUNITY',priority:'HIGH',reason:community.monitoring?.reason || community.membershipState,
      question:community.humanQuestion || '',allowedActions:external?[]:['ANSWER_IN_COMMUNITIES'],externalActionRequired:external,platform:'Facebook',
      recommendedAction:external?'Completa la acción en Facebook; luego usa Sync Communities.':'Responde en COMMUNITIES y usa Sync Communities.',
      createdAt:community.lastCheckedAt || community.lastSeenAt,lastUpdatedAt:community.updatedAt}));
  }

  const order = new Map(ATTENTION_ORDER.map((value,index)=>[value,index]));
  return [...new Map(items.map(value=>[value.attentionId,value])).values()].sort((a,b)=>(order.get(a.attentionType)??99)-(order.get(b.attentionType)??99)
    || ({CRITICAL:0,HIGH:1,NORMAL:2,LOW:3}[a.priority]??9)-({CRITICAL:0,HIGH:1,NORMAL:2,LOW:3}[b.priority]??9)
    || text(a.createdAt).localeCompare(text(b.createdAt)));
}

export class HumanAttentionService {
  constructor({registry,clock=()=>new Date()}={}) { if(!registry)throw new TypeError('registry is required');this.registry=registry;this.clock=clock; }
  getAttentionItems(){return deriveHumanAttentionItems(this.registry.getControlPlaneData({candidateScope:'decision',includeAttention:false}),{now:this.clock()});}
  getAttentionForJob(jobId){return this.getAttentionItems().filter(item=>item.jobId===String(jobId));}
  getAttentionCounts(){const items=this.getAttentionItems(),byType=Object.fromEntries(ATTENTION_TYPES.map(type=>[type,0]));for(const value of items)byType[value.attentionType]++;return{total:items.length,byType,clear:items.length===0};}
  validateHumanInput({field,value,attentionType}={}){const name=text(field).toLowerCase().replaceAll(' ','_'),normalized=upper(value);if(name==='human_resolution'||attentionType==='VERIFICATION_REQUIRED'){const ok=VERIFICATION_RESOLUTIONS.includes(normalized);return{ok,value:normalized,error:ok?null:HUMAN_INPUT_ERROR.human_resolution,allowed:VERIFICATION_RESOLUTIONS};}return{ok:true,value:text(value),error:null};}
  resolveImportedAction(action){
    if(action?.entityType!=='JOB'||action.field!=='human_resolution')return{status:'NOT_APPLICABLE'};
    const validation=this.validateHumanInput({field:'human_resolution',value:action.value});if(!validation.ok)return{status:'REJECTED',...validation};
    const execution=this.registry.listApplicationExecutions({jobId:action.entityId,status:'NEEDS_HUMAN'}).filter(value=>value.blocker?.code==='VERIFICATION_UNKNOWN').at(-1);
    if(!execution)return{status:'STALE',resolution:validation.value};
    const notes=this.registry.getHumanFieldState().find(value=>value.entityType==='JOB'&&value.entityId===action.entityId&&value.field==='resolution_notes')?.value||'';
    const base={aggregateType:'APPLICATION',aggregateId:execution.id,correlationId:this.registry._eventCorrelationForJob(action.entityId,`human-action:${action.id}`),causationId:action.id,source:'sheet',actorType:'HUMAN',actorId:action.user||'sheet-user',metadata:{refs:{jobId:action.entityId,applicationId:execution.id,humanActionId:action.id}},payload:{resolution:validation.value,resolvedBy:'HUMAN',resolvedAt:this.registry.now(),notes:text(notes)}};
    if(validation.value==='KEEP_UNKNOWN'){
      this.registry.recordWorkflowEvent({...base,eventType:'APPLICATION_VERIFICATION_RETAINED',dedupeKey:`human-action:${action.id}:verification-retained`});return{status:'RETAINED',resolution:validation.value,execution};
    }
    const confirmed=validation.value==='CONFIRMED_APPLIED';
    const updated=this.registry.finishApplicationExecution(execution.id,{status:confirmed?'APPLIED':'CANCELLED',stage:'RECONCILIATION',reason:confirmed?'human_confirmed_applied':'human_confirmed_not_applied',confirmation:confirmed?{id:`human:${action.id}`,source:'HUMAN',resolutionNotes:text(notes)}:{},blocker:{}});
    if(!confirmed)this.registry.db.prepare(`INSERT INTO human_field_state(entity_type,entity_id,field_name,value_json,source_action_id,updated_at) VALUES('JOB',?,'application_decision','"HOLD"',?,?) ON CONFLICT(entity_type,entity_id,field_name) DO UPDATE SET value_json='"HOLD"',source_action_id=excluded.source_action_id,updated_at=excluded.updated_at`).run(action.entityId,action.id,this.registry.now());
    this.registry.db.prepare(`UPDATE operational_signals SET status='CLOSED',resolved_at=?,resolution_reason=?,updated_at=? WHERE status IN ('OPEN','RECOVERING','ESCALATED') AND component='application_execution' AND (aggregate_id=? OR aggregate_id=?)`).run(this.registry.now(),`human_${validation.value.toLowerCase()}`,this.registry.now(),execution.id,action.entityId);
    this.registry.recordWorkflowEvent({...base,eventType:confirmed?'APPLICATION_HUMAN_CONFIRMED':'APPLICATION_HUMAN_NOT_APPLIED',payload:{...base.payload,status:updated.status},dedupeKey:`human-action:${action.id}:${confirmed?'human-confirmed':'human-not-applied'}`});
    return{status:updated.status,resolution:validation.value,execution:updated,externalSubmitClicks:0};
  }
}
