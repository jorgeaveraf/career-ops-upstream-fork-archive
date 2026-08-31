import { CANONICAL_HUMAN_DECISIONS, LEGACY_HUMAN_DECISIONS, REJECTION_REASONS } from '../human-decision/contracts.mjs';

export const CONTROL_PLANE_VERSION = '4.4';
export const CONTROL_PLANE_TABS = Object.freeze(['TODAY', 'PIPELINE', 'RESEARCH', 'COMMUNITIES', 'APPLICATIONS', 'CONTACTS', 'FOLLOW_UPS', 'SETTINGS']);
export const OPTIONAL_CONTROL_PLANE_TABS = Object.freeze(['SOURCE_METRICS']);

const tab = (key, columns, humanOwned = []) => Object.freeze({ key, columns: Object.freeze(columns), humanOwned: Object.freeze(humanOwned), careerOwned: Object.freeze(columns.filter(column => !humanOwned.includes(column))) });
export const TAB_CONTRACTS = Object.freeze({
  TODAY: tab('Entity ID', [
    'Stage', 'Company', 'Role', 'Status', 'Action', 'Handoff Type', 'Handoff Instruction', 'Open Application', 'Question Bundle', 'Application Progress', 'Recommendation', 'Rank', 'Location', 'Attention Type',
    'Lane', 'Question', 'Reason', 'Allowed Actions',
    'Workflow Stage', 'Workflow Status', 'Last Activity', 'Last Updated',
    'Attention Priority', 'Recommended Action',
    'Human Decision', 'Rejection Reason', 'Application Decision', 'Outreach Decision', 'Human Answer', 'Human Resolution', 'Resolution Notes', 'Follow-Up Date', 'Follow-Up Action', 'Notes', 'Outcome',
    'Evaluation', 'Key Fit Reasons', 'Meaningful Gaps', 'Application Path', 'Activation Status', 'Primary Contact', 'Outreach Recommendation', 'Outreach Channel', 'Outreach Timing', 'Outreach Status', 'Suggested Message', 'Package Version', 'Resume', 'Cover Letter', 'Contacts', 'Job URL',
    'Movement', 'Eligibility', 'Final Priority', 'Evidence Confidence', 'Missing Evidence', 'Why This Role',
    'Last Command', 'Command Status', 'Command Result', 'Attention Status', 'Enrichment Summary', 'Last Enriched', 'Human Blocker', 'Lifecycle State', 'Decision Outcome', 'Enrichment Status', 'Execution Status', 'Entity Type', 'Job ID', 'Question ID', 'Entity ID', 'Projection Hash',
  ], ['Human Decision', 'Rejection Reason', 'Application Decision', 'Outreach Decision', 'Human Answer', 'Human Resolution', 'Resolution Notes', 'Follow-Up Date', 'Follow-Up Action', 'Notes', 'Outcome']),
  PIPELINE: tab('Entity ID', ['Pipeline Rank', 'Company', 'Role', 'Recommendation', 'Candidate Fit', 'Opportunity Quality', 'Evidence Confidence', 'Location', 'Employment Model', 'State', 'Final Priority', 'Why This Role', 'Freshness', 'Source', 'Human Decision', 'Rejection Reason', 'Decision Outcome', 'Enrichment Status', 'Last Updated', 'Job URL', 'Admission Reason', 'Policy Version', 'Entity ID', 'Projection Hash'], ['Human Decision', 'Rejection Reason']),
  RESEARCH: tab('Entity ID', ['Research Priority', 'Company', 'Role', 'Current Rank', 'Eligibility', 'Potential Value', 'Needs', 'Primary Blocker', 'Status', 'Last Research', 'Job URL', 'Human Notes', 'Entity ID', 'Projection Hash'], ['Human Notes']),
  COMMUNITIES: tab('Entity ID', ['Recommendation','Community','Workflow Stage','Workflow Status','Last Activity','Last Updated','Topic','Visibility','Members','Activity','Opportunity Signal','Spam','Quality','Membership State','Monitoring Readiness','Monitoring Status','Posts Seen','Opportunities Found','Why It Matters','Group URL','Membership Decision','Notes','Last Checked','Entity ID','Projection Hash'], ['Membership Decision','Notes']),
  APPLICATIONS: tab('Entity ID', ['Company', 'Role', 'Applied At', 'Application Source/Platform', 'Application URL', 'Application Channel', 'Execution Mode', 'Package Version', 'Resume', 'Cover Letter', 'Confirmation', 'Application Status', 'Primary Contact', 'Outreach Recommendation', 'Outreach Channel', 'Outreach Status', 'Outreach Sent At', 'Follow-Up Date', 'Response Status', 'Interview Date', 'Next Action', 'Outcome', 'Job URL', 'Notes', 'Entity ID', 'Projection Hash'], ['Follow-Up Date', 'Response Status', 'Interview Date', 'Next Action', 'Outcome', 'Notes']),
  CONTACTS: tab('Entity ID', ['Job', 'Company', 'Name', 'Title', 'Contact Type', 'Why Relevant', 'Confidence', 'Public Profile', 'Public Email', 'Source', 'Verified At', 'Contact Status', 'Outreach Status', 'Outreach Outcome', 'Notes', 'Job URL', 'Job ID', 'Entity ID', 'Projection Hash'], ['Outreach Outcome', 'Notes']),
  FOLLOW_UPS: tab('Entity ID', ['Date', 'Action', 'Related Job', 'Status', 'Notes', 'Entity ID'], ['Date', 'Action', 'Related Job', 'Status', 'Notes']),
  SETTINGS: tab('Key', ['Key', 'Value', 'Owner', 'Description']),
  SOURCE_METRICS: tab('Metric ID', ['Scope', 'Source', 'Strategy', 'Observed', 'Valid', 'Duplicates', 'Eligibility Resolved', 'Shortlist', 'Evaluated', 'Strong Pool Admitted', 'TODAY', 'Pipeline Waiting', 'Applied', 'Package Ready', 'Provider ROI', 'Evaluation ROI', 'Last Run', 'Metric ID']),
});
export const HUMAN_DECISIONS = CANONICAL_HUMAN_DECISIONS;
export const APPLICATION_STATUSES = Object.freeze(['NO_OUTCOME','APPLIED','FOLLOW_UP','INTERVIEW','REJECTED_BY_COMPANY','OFFER','HIRED','WITHDRAWN','REJECTED','NO_RESPONSE','FAILED']);
export const APPLICATION_DECISIONS = Object.freeze(['NO_ACTION', 'APPROVE_TO_APPLY', 'HOLD', 'REJECT']);
export const COMMUNITY_DECISIONS = Object.freeze(['NO_ACTION','WANT_TO_JOIN','JOINED','SKIP','REJECT']);
export const OUTREACH_STATUSES = Object.freeze(['NONE','READY','AUTHORIZED','SCHEDULED','SENDING','SENT','NEEDS_YOU','VERIFICATION_REQUIRED','FAILED']);
export const OUTREACH_DECISIONS = Object.freeze(['NO_ACTION', 'APPROVE_OUTREACH', 'SKIP_OUTREACH', 'HOLD']);
export const OUTREACH_OUTCOMES = Object.freeze(['UNKNOWN', 'NO_RESPONSE', 'REPLIED', 'RECRUITER_SCREEN', 'INTERVIEW', 'REFERRED', 'NEGATIVE']);
export const FOLLOW_UP_STATUSES = Object.freeze(['PENDING', 'DONE', 'CANCELLED']);
export const HUMAN_RESOLUTIONS = Object.freeze(['CONFIRMED_APPLIED','NOT_APPLIED','KEEP_UNKNOWN']);
export const HUMAN_FIELD_VALIDATION = Object.freeze({
  'TODAY.Human Decision': Object.freeze([...HUMAN_DECISIONS, ...LEGACY_HUMAN_DECISIONS]),
  'PIPELINE.Human Decision': Object.freeze([...HUMAN_DECISIONS, ...LEGACY_HUMAN_DECISIONS]),
  'TODAY.Rejection Reason': REJECTION_REASONS,
  'TODAY.Application Decision': APPLICATION_DECISIONS,
  'TODAY.Outreach Decision': OUTREACH_DECISIONS,
  'TODAY.Human Resolution': HUMAN_RESOLUTIONS,
  'TODAY.Outcome': APPLICATION_STATUSES,
  'PIPELINE.Rejection Reason': REJECTION_REASONS,
  'APPLICATIONS.Outcome': APPLICATION_STATUSES,
  'COMMUNITIES.Membership Decision': COMMUNITY_DECISIONS,
  'CONTACTS.Outreach Outcome': OUTREACH_OUTCOMES,
  'FOLLOW_UPS.Status': FOLLOW_UP_STATUSES,
});
