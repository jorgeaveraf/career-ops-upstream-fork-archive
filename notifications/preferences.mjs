const truthy = value => String(value || '').toLowerCase() === 'true';
const emailLike = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

export const ACTIONABLE_NOTIFICATION_TYPES = Object.freeze([
  'NEEDS_HUMAN','READY_FOR_REVIEW','APPLICATION_CONFIRMED','APPLICATION_FAILED',
  'COMMAND_FAILED','ENRICHMENT_BLOCKED','COMMUNITY_NEEDS_HUMAN','OPERATIONAL_ESCALATION',
  'OUTREACH_FAILED','OUTREACH_VERIFICATION_REQUIRED','EXTERNAL_ACTION_REQUIRED','RESPONSE_RECEIVED',
  'WORKFLOW_DIGEST',
]);
export const DAILY_NOTIFICATION_TYPE='DAILY_COMPLETION_SUMMARY';

export function notificationPreferencesFromEnv(env = process.env) {
  const enabled=truthy(env.CAREER_OPS_NOTIFICATIONS_ENABLED);
  const recipient=String(env.CAREER_OPS_NOTIFICATION_RECIPIENT || env.CAREER_OPS_EMAIL_TO || '').trim();
  const events=Object.fromEntries(ACTIONABLE_NOTIFICATION_TYPES.map(type=>{
    const key=`CAREER_OPS_NOTIFY_${type}`;return[type,env[key]==null?true:truthy(env[key])];
  }));
  const dailyCompletionSummary=env.CAREER_OPS_DAILY_COMPLETION_SUMMARY==null?true:truthy(env.CAREER_OPS_DAILY_COMPLETION_SUMMARY);
  const workflowDigests=env.CAREER_OPS_WORKFLOW_DIGESTS==null?true:truthy(env.CAREER_OPS_WORKFLOW_DIGESTS);
  return { enabled, recipient, channel:'email', provider:String(env.CAREER_OPS_EMAIL_PROVIDER || 'resend').toLowerCase(), events:{...events,WORKFLOW_DIGEST:workflowDigests,[DAILY_NOTIFICATION_TYPE]:dailyCompletionSummary},workflowDigests,dailyCompletionSummary };
}

export function validateNotificationPreferences(preferences = {}) {
  const errors=[];
  if(preferences.enabled&&!emailLike(preferences.recipient))errors.push({code:'NOTIFICATION_RECIPIENT_INVALID',message:'Notification recipient must be a valid email address'});
  if(String(preferences.recipient).toLowerCase()==='fubifo@gmail.com')errors.push({code:'NOTIFICATION_RECIPIENT_FORBIDDEN',message:'Platform sign-up identity cannot receive system notifications'});
  return {ok:errors.length===0,errors};
}
