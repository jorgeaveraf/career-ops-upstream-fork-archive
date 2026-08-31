import { createHash } from 'crypto';

export const OPERATIONAL_POLICY_VERSION = '3E.1';
export const SIGNAL_STATUSES = Object.freeze(['OPEN','RECOVERING','RECOVERED','ESCALATED','SUPPRESSED','CLOSED']);
export const SIGNAL_SEVERITIES = Object.freeze(['INFO','WARN','ERROR','CRITICAL']);
export const SAFETY_CLASSES = Object.freeze(['INTERNAL_ONLY','SAFE_IDEMPOTENT_EXTERNAL','AMBIGUOUS_EXTERNAL','HUMAN_DECISION']);
export const REMEDIATION_DECISIONS = Object.freeze(['AUTO_RECOVER','RETRY_SAFE','ESCALATE','SUPPRESS','DO_NOT_TOUCH']);
export const OPERATIONAL_SIGNAL_TYPES = Object.freeze([
  'COMMAND_STUCK','WORKFLOW_STUCK','SUBSCRIBER_DOWN','LAUNCHAGENT_DOWN','PUBSUB_BACKLOG','GATEWAY_UNHEALTHY',
  'SHEET_SYNC_FAILURE','AUTH_FAILURE','WORKSPACE_AUTH_FAILED','WORKSPACE_AUTH_RECOVERED','CANDIDATE_GMAIL_AUTH_FAILED','CANDIDATE_GMAIL_AUTH_RECOVERED','NOTIFICATION_BACKLOG','NOTIFICATION_PROVIDER_FAILURE','BROWSER_LOCK_STALE',
  'BROWSER_SELECTOR_DRIFT','BROWSER_CHALLENGE_SPIKE','PROVIDER_FAILURE_SPIKE','ENRICHMENT_STUCK',
  'APPLICATION_EXECUTION_STUCK','APPLICATION_VERIFICATION_UNKNOWN','ORPHANED_OPERATIONAL_RUN','OPERATIONAL_WATCH_FAILURE',
  'WORKER_QUEUE_STALE',
  'TODAY_REFILL_BLOCKED','TODAY_ADMISSIBLE_NOT_PROJECTED','TODAY_STATE_CONTRADICTION','TODAY_RANK_INVARIANT_FAILED',
]);
export const ALLOWED_REMEDIATION_ACTIONS = Object.freeze([
  'RESTART_COMMAND_SUBSCRIBER','RESTART_LAUNCHAGENT','CLEAR_STALE_BROWSER_LOCK','RECOVER_ORPHANED_COMMAND',
  'RECOVER_ORPHANED_RUN','REQUEUE_SAFE_ENRICHMENT','RETRY_GOOGLE_AUTH','RETRY_SHEET_SYNC','DRAIN_NOTIFICATION_OUTBOX','TEMPORARILY_DEGRADE_SOURCE',
  'WAKE_EXECUTION_WORKER',
]);
export const FORBIDDEN_REMEDIATION_ACTIONS = Object.freeze([
  'RETRY_APPLICATION_SUBMIT','RESEND_AMBIGUOUS_EMAIL','RETRY_SOCIAL_MESSAGE','BYPASS_CHALLENGE',
  'ANSWER_HUMAN_QUESTION','CHANGE_RANKING_POLICY','MODIFY_DNS','ROTATE_KEYS','CHANGE_IAM','CREATE_ACCOUNTS','MODIFY_BROWSER_PROFILE',
]);
export const DEFAULT_OPERATIONAL_THRESHOLDS = Object.freeze({
  commandMs:5*60_000, prepareMs:30*60_000, applyMs:10*60_000, communityMs:10*60_000,
  operationalRunMs:30*60_000, browserLockMs:30*60_000, sheetFailureCount:2,
  notificationPendingCount:5, notificationPendingAgeMs:10*60_000, selectorDriftCount:3,
  challengeSpikeCount:3, providerFailureCount:3, pubsubWarnAgeSeconds:120, pubsubErrorAgeSeconds:600,
  maxRecoveryAttempts:2, flapThreshold:5, watchStaleMs:15*60_000,
});

const required = (value, name) => { const result=String(value??'').trim(); if(!result)throw new TypeError(`${name} is required`); return result; };
export function signalDedupeKey(input={}) {
  const raw=[input.signalType,input.component,input.aggregateType,input.aggregateId].map(value=>required(value,'signal identity')).join(':');
  return createHash('sha256').update(raw).digest('hex');
}
export function normalizeOperationalSignal(input={}) {
  const signalType=required(input.signalType,'signalType'),severity=required(input.severity,'severity').toUpperCase();
  const safetyClass=required(input.safetyClass,'safetyClass').toUpperCase();
  if(!OPERATIONAL_SIGNAL_TYPES.includes(signalType))throw new TypeError(`unknown operational signal type: ${signalType}`);
  if(!SIGNAL_SEVERITIES.includes(severity))throw new TypeError(`unknown operational severity: ${severity}`);
  if(!SAFETY_CLASSES.includes(safetyClass))throw new TypeError(`unknown recovery safety class: ${safetyClass}`);
  if(input.remediationAction&&!ALLOWED_REMEDIATION_ACTIONS.includes(input.remediationAction))throw new TypeError(`remediation action is not allowlisted: ${input.remediationAction}`);
  return {...input,signalType,severity,safetyClass,component:required(input.component,'component'),aggregateType:required(input.aggregateType,'aggregateType'),aggregateId:required(input.aggregateId,'aggregateId'),correlationId:required(input.correlationId,'correlationId'),summary:required(input.summary,'summary'),recommendedAction:required(input.recommendedAction,'recommendedAction'),evidenceRefs:Array.isArray(input.evidenceRefs)?input.evidenceRefs:[],autoRecoverable:Boolean(input.autoRecoverable),policyVersion:input.policyVersion||OPERATIONAL_POLICY_VERSION,dedupeKey:input.dedupeKey||signalDedupeKey(input)};
}
