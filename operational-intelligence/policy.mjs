import { ALLOWED_REMEDIATION_ACTIONS, DEFAULT_OPERATIONAL_THRESHOLDS, FORBIDDEN_REMEDIATION_ACTIONS } from './contracts.mjs';

export class RecoverySafetyClassifier {
  classify(signal={}){
    if(signal.signalType==='APPLICATION_VERIFICATION_UNKNOWN'||signal.externalMutationObserved)return'AMBIGUOUS_EXTERNAL';
    if(['BROWSER_SELECTOR_DRIFT','BROWSER_CHALLENGE_SPIKE','GATEWAY_UNHEALTHY'].includes(signal.signalType))return'HUMAN_DECISION';
    if(['AUTH_FAILURE','WORKSPACE_AUTH_FAILED'].includes(signal.signalType))return'SAFE_IDEMPOTENT_EXTERNAL';
    if(['SHEET_SYNC_FAILURE','NOTIFICATION_BACKLOG'].includes(signal.signalType))return'SAFE_IDEMPOTENT_EXTERNAL';
    if(signal.signalType==='NOTIFICATION_PROVIDER_FAILURE'&&signal.notificationAmbiguous)return'AMBIGUOUS_EXTERNAL';
    return'INTERNAL_ONLY';
  }
}

export class OperationalRemediationPolicy {
  constructor({thresholds=DEFAULT_OPERATIONAL_THRESHOLDS,classifier=new RecoverySafetyClassifier()}={}){this.thresholds=thresholds;this.classifier=classifier;}
  decide(signal,{attempts=0}={}){
    const safetyClass=signal.safetyClass||this.classifier.classify(signal);
    if(signal.flapCount>=this.thresholds.flapThreshold)return{decision:'ESCALATE',reason:'FLAPPING',safetyClass};
    if(safetyClass==='AMBIGUOUS_EXTERNAL')return{decision:'DO_NOT_TOUCH',reason:'AMBIGUOUS_EXTERNAL',safetyClass};
    if(safetyClass==='HUMAN_DECISION')return{decision:signal.severity==='INFO'?'SUPPRESS':'ESCALATE',reason:'HUMAN_OR_CONFIGURATION_REQUIRED',safetyClass};
    if(!signal.remediationAction)return{decision:signal.severity==='INFO'?'SUPPRESS':'ESCALATE',reason:'NO_ALLOWLISTED_ACTION',safetyClass};
    if(FORBIDDEN_REMEDIATION_ACTIONS.includes(signal.remediationAction)||!ALLOWED_REMEDIATION_ACTIONS.includes(signal.remediationAction))return{decision:'DO_NOT_TOUCH',reason:'POLICY_BLOCKED',safetyClass};
    if(attempts>=this.thresholds.maxRecoveryAttempts)return{decision:'ESCALATE',reason:'RECOVERY_ATTEMPTS_EXHAUSTED',safetyClass};
    return{decision:safetyClass==='SAFE_IDEMPOTENT_EXTERNAL'?'RETRY_SAFE':'AUTO_RECOVER',reason:'ALLOWLISTED_BOUNDED_RECOVERY',safetyClass};
  }
}

export function assertAllowedRecoveryAction(action){if(FORBIDDEN_REMEDIATION_ACTIONS.includes(action)||!ALLOWED_REMEDIATION_ACTIONS.includes(action)){const error=new Error(`recovery action is policy blocked: ${action}`);error.code='POLICY_BLOCKED';throw error;}return action;}
