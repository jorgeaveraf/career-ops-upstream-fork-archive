const POLICY = Object.freeze({
  APPLICATION_NEEDS_HUMAN:{type:'NEEDS_HUMAN',priority:'HIGH'},
  APPLICATION_VERIFICATION_UNKNOWN:{type:'NEEDS_HUMAN',priority:'CRITICAL'},
  ENRICHMENT_COMPLETED:{type:'READY_FOR_REVIEW',priority:'NORMAL'},
  APPLICATION_CONFIRMED:{type:'APPLICATION_CONFIRMED',priority:'NORMAL'},
  APPLICATION_FAILED:{type:'APPLICATION_FAILED',priority:'HIGH'},
  ENRICHMENT_BLOCKED:{type:'ENRICHMENT_BLOCKED',priority:'NORMAL'},
  ENRICHMENT_FAILED:{type:'ENRICHMENT_BLOCKED',priority:'NORMAL'},
  COMMAND_FAILED:{type:'COMMAND_FAILED',priority:'NORMAL'},
  COMMUNITY_NEEDS_HUMAN:{type:'COMMUNITY_NEEDS_HUMAN',priority:'HIGH'},
  OPERATIONAL_ESCALATED:{type:'OPERATIONAL_ESCALATION',priority:'HIGH'},
  OUTREACH_FAILED:{type:'OUTREACH_FAILED',priority:'HIGH'},
  OUTREACH_VERIFICATION_REQUIRED:{type:'OUTREACH_VERIFICATION_REQUIRED',priority:'HIGH'},
  OUTREACH_EXTERNAL_ACTION_REQUIRED:{type:'EXTERNAL_ACTION_REQUIRED',priority:'HIGH'},
  OUTREACH_RESPONSE_RECEIVED:{type:'RESPONSE_RECEIVED',priority:'HIGH'},
});

export class NotificationPolicyEngine {
  evaluate({ event, domain = {}, preferences } = {}) {
    if(!event?.eventType)return{decision:'SUPPRESS',reason:'invalid_event'};
    if(event.refs?.aggregateType==='NOTIFICATION'||event.eventType.startsWith('NOTIFICATION_'))return{decision:'SUPPRESS',reason:'notification_event'};
    const rule=POLICY[event.eventType];if(!rule)return{decision:'SUPPRESS',reason:'not_actionable'};
    if(event.eventType==='APPLICATION_CONFIRMED'&&event.payload?.reasonCode==='reconciled_observable_confirmation')return{decision:'SUPPRESS',reason:'silent_confirmation_repair',notificationType:rule.type};
    if(['ENRICHMENT_COMPLETED','ENRICHMENT_BLOCKED','ENRICHMENT_FAILED'].includes(event.eventType)&&String(event.refs?.runId||'').startsWith('enrichment-drain-'))return{decision:'SUPPRESS',reason:'captured_by_workflow_digest',notificationType:rule.type};
    if(event.eventType==='OPERATIONAL_ESCALATED'&&event.payload?.notificationSuppressed)return{decision:'SUPPRESS',reason:'lifecycle_notification_exists',notificationType:rule.type};
    if(!preferences?.events?.[rule.type])return{decision:'SUPPRESS',reason:'preference_disabled',notificationType:rule.type};
    if(event.eventType==='ENRICHMENT_COMPLETED'&&(!domain.enrichmentReady||!domain.packageValid))return{decision:'DEFER',reason:'ready_state_not_authoritative',notificationType:rule.type};
    if(event.eventType==='COMMAND_FAILED'&&!domain.userInitiatedCommand)return{decision:'SUPPRESS',reason:'command_not_user_initiated',notificationType:rule.type};
    if(event.eventType==='COMMUNITY_NEEDS_HUMAN'&&!domain.authorizedCommunityJoin)return{decision:'SUPPRESS',reason:'community_join_not_authorized',notificationType:rule.type};
    return {decision:'NOTIFY',notificationType:rule.type,priority:rule.priority};
  }
}

export function notificationRuleForEvent(eventType){return POLICY[eventType]||null;}
