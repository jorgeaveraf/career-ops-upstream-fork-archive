export const HUMAN_STAGES = Object.freeze(['DISCOVERED', 'PREPARING', 'READY']);
export const HUMAN_STATUSES = Object.freeze(['WAITING_FOR_YOU', 'WORKING', 'QUEUED', 'READY', 'BLOCKED', 'ON_HOLD']);

const upper = value => String(value ?? '').trim().toUpperCase();

export function projectHumanState({ humanDecision = 'NO_ACTION', applicationDecision = 'NO_ACTION', enrichment = null,
  execution = null, readiness = null, attentionType = '', blocker = '' } = {}) {
  const decision = upper(humanDecision) || 'NO_ACTION';
  const approval = upper(applicationDecision) || 'NO_ACTION';
  const enrichmentStatus = upper(enrichment?.status);
  const executionStatus = upper(execution?.status);
  const attention = upper(attentionType);
  const blocked = Boolean(blocker) || ['BLOCKED', 'FAILED'].includes(enrichmentStatus) || executionStatus === 'FAILED';
  const reauthorization = attention === 'APPROVAL_REQUIRED' && approval === 'HOLD'
    && executionStatus === 'CANCELLED' && enrichmentStatus === 'READY_FOR_REVIEW';
  const result = (stage, status, action, { inToday = true, humanAttention = false, contradiction = null } = {}) => {
    const projected={ stage, status, action, inToday };
    // Keep the established enumerable projection contract stable while making
    // V4.6 semantic metadata available to the canonical counter/diagnostics.
    Object.defineProperties(projected,{humanAttention:{value:humanAttention,enumerable:false},contradiction:{value:contradiction,enumerable:false}});
    return projected;
  };

  if (executionStatus === 'APPLIED') return result('APPLIED', 'READY', 'Applied', { inToday:false });
  // A cancelled attempt is history. When readiness plus an explicit approval
  // item asks for a new authorization, that current instruction outranks the
  // safety HOLD without erasing either historical fact.
  if (reauthorization) return result('READY', 'WAITING_FOR_YOU', 'Authorize new attempt', { humanAttention:true });
  if (executionStatus === 'NEEDS_HUMAN') {
    const verify = attention === 'VERIFICATION_REQUIRED';
    return result('READY', 'WAITING_FOR_YOU', verify ? 'Verify submission' : 'Answer question', { humanAttention:true });
  }
  if ((decision === 'HOLD' || approval === 'HOLD') && attention) {
    return result(readiness?.ready?'READY':enrichmentStatus?'PREPARING':'DISCOVERED', 'BLOCKED', 'Resolve state conflict', {
      contradiction:{ code:'TODAY_STATE_CONTRADICTION', reason:'HOLD_WITH_COMPETING_HUMAN_ACTION', attentionType:attention },
    });
  }
  if (decision === 'HOLD' || approval === 'HOLD') {
    const stage = readiness?.ready ? 'READY' : enrichmentStatus ? 'PREPARING' : 'DISCOVERED';
    return result(stage, 'ON_HOLD', 'On hold');
  }
  if (['EXECUTING'].includes(executionStatus)) return result('READY', 'WORKING', 'Waiting on Career Ops');
  if (approval === 'APPROVE_TO_APPLY') return result('READY', 'QUEUED', 'Waiting on Career Ops');
  if (readiness?.ready && enrichmentStatus === 'READY_FOR_REVIEW') return result('READY', 'WAITING_FOR_YOU', attention === 'APPROVAL_REQUIRED' ? 'Authorize application' : readiness?.recommendation==='APPLY'?'Review package':'Review evaluation', { humanAttention:Boolean(attention) });
  if (decision === 'NEXT_STAGE' || enrichmentStatus) {
    if (blocked) return result('PREPARING', 'BLOCKED', 'Blocked');
    if (enrichmentStatus === 'PENDING') return result('PREPARING', 'QUEUED', 'Waiting on Career Ops');
    return result('PREPARING', 'WORKING', 'Waiting on Career Ops');
  }
  if (blocked) return result('DISCOVERED', 'BLOCKED', 'Blocked');
  return result('DISCOVERED', 'WAITING_FOR_YOU', 'Decide', { humanAttention:Boolean(attention) });
}
