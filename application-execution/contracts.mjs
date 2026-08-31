export const APPLICATION_EXECUTION_VERSION='2D.1';
export const APPLICATION_EXECUTION_STATUSES=Object.freeze(['APPROVED_TO_APPLY','EXECUTING','APPLIED','PARTIALLY_APPLIED','NEEDS_HUMAN','FAILED','CANCELLED']);
export const PRIMARY_APPLICATION_CHANNELS=Object.freeze(['ATS','EMAIL','PLATFORM','MANUAL_EXTERNAL','UNKNOWN']);
export const SECONDARY_OUTREACH_CHANNELS=Object.freeze(['NONE','EMAIL','LINKEDIN','FACEBOOK','INSTAGRAM']);
export const APPLICATION_EXECUTION_MODES=Object.freeze(['NATIVE','GENERIC_BROWSER','MANUAL_SECURITY_BOUNDARY']);
export const APPLICATION_EXECUTION_TRANSITIONS=Object.freeze({APPROVED_TO_APPLY:['EXECUTING','CANCELLED'],EXECUTING:['APPLIED','PARTIALLY_APPLIED','NEEDS_HUMAN','FAILED','CANCELLED'],PARTIALLY_APPLIED:['EXECUTING','NEEDS_HUMAN','FAILED','CANCELLED'],NEEDS_HUMAN:['EXECUTING','APPLIED','CANCELLED'],APPLIED:[],FAILED:[],CANCELLED:[]});
export const HUMAN_ONLY_FIELD_PATTERNS=Object.freeze([/desired salary|salary expectation|expected compensation/i,/earliest start|available to start|start date/i,/relocat/i,/security clearance/i,/certif/i,/signature|attest|declare/i,/essay|tell us about|why do you want/i,/sponsor|work authorization/i]);
