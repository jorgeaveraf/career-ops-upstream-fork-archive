import { hashStable } from '../acquisition/normalize.mjs';
import { HUMAN_FIELD_VALIDATION, TAB_CONTRACTS } from './contracts.mjs';
import { canonicalHumanDecision } from '../human-decision/contracts.mjs';

const FIELD_MAP = Object.freeze({
  'TODAY.Human Decision': ['JOB', 'human_decision'], 'TODAY.Rejection Reason': ['JOB', 'rejection_reason'], 'TODAY.Application Decision': ['JOB', 'application_decision'], 'TODAY.Outreach Decision': ['JOB', 'outreach_decision'], 'TODAY.Human Answer': ['JOB', 'human_answer'], 'TODAY.Human Resolution': ['JOB','human_resolution'], 'TODAY.Resolution Notes': ['JOB','resolution_notes'], 'TODAY.Follow-Up Date': ['JOB','follow_up_date'], 'TODAY.Follow-Up Action': ['JOB','follow_up_action'], 'TODAY.Notes': ['JOB', 'notes'], 'TODAY.Outcome': ['JOB','application_status'],
  'PIPELINE.Human Decision': ['JOB', 'human_decision'], 'PIPELINE.Rejection Reason': ['JOB', 'rejection_reason'], 'RESEARCH.Human Notes': ['JOB', 'research_notes'],
  'COMMUNITIES.Membership Decision': ['COMMUNITY','membership_decision'], 'COMMUNITIES.Notes': ['COMMUNITY','notes'],
  'APPLICATIONS.Outcome': ['JOB', 'application_status'], 'APPLICATIONS.Interview Date': ['JOB', 'interview_date'], 'APPLICATIONS.Next Action': ['JOB', 'next_action'],
  'APPLICATIONS.Notes': ['JOB', 'application_notes'], 'CONTACTS.Outreach Status': ['JOB', 'contact_outreach_status'], 'CONTACTS.Outreach Outcome': ['JOB', 'contact_outreach_outcome'],
  'CONTACTS.Notes': ['JOB', 'contact_notes'], 'FOLLOW_UPS.Date': ['FOLLOW_UP', 'date'],
  'FOLLOW_UPS.Action': ['FOLLOW_UP', 'action'], 'FOLLOW_UPS.Related Job': ['FOLLOW_UP', 'related_job_id'],
  'FOLLOW_UPS.Status': ['FOLLOW_UP', 'status'], 'FOLLOW_UPS.Notes': ['FOLLOW_UP', 'notes'],
});

function normalized(value) { return value == null ? '' : String(value).trim(); }

export function collectHumanActions({ projection, sheetRows, spreadsheetId, observedAt, user = 'sheet-user' }) {
  const accepted = []; const rejected = [];
  const reject = item => rejected.push({ spreadsheetId, observedAt, user, ...item });
  for (const [tabName, contract] of Object.entries(TAB_CONTRACTS)) {
    if (tabName === 'SETTINGS') continue;
    const projectedById = new Map((projection.tabs[tabName] || []).map(row => [normalized(row[contract.key]), row]));
    for (const row of sheetRows[tabName] || []) {
      const rowId = normalized(row[contract.key]);
      if (!rowId) { if (tabName === 'FOLLOW_UPS') reject({ tabName, reason: 'FOLLOW_UP_REQUIRES_ENTITY_ID', row }); continue; }
      const baseline = projectedById.get(rowId);
      const entityId = normalized(baseline?.['Job ID']) || rowId;
      if (!baseline && tabName !== 'FOLLOW_UPS') { reject({ tabName, entityId, reason: 'UNKNOWN_ENTITY' }); continue; }
      for (const field of contract.careerOwned) {
        if (baseline && normalized(row[field]) !== normalized(baseline[field])) reject({ tabName, entityId, field, value: row[field], reason: 'CAREER_OWNED_FIELD' });
      }
      for (const field of contract.humanOwned) {
        if (!Object.hasOwn(row, field)) continue;
        const rawValue = normalized(row[field]);
        const before = normalized(baseline?.[field]);
        const value = field === 'Human Decision' ? canonicalHumanDecision(rawValue)
          : field === 'Application Decision' && !rawValue ? 'NO_ACTION'
            : field === 'Outreach Decision' && !rawValue && before === 'NO_ACTION' ? 'NO_ACTION' : rawValue;
        if (value === (field === 'Human Decision' ? canonicalHumanDecision(before) : before) || (!value && !before)) continue;
        const validation = HUMAN_FIELD_VALIDATION[`${tabName}.${field}`];
        if (validation && rawValue && !validation.includes(rawValue)) { reject({ tabName, entityId, field, value: rawValue, reason: 'INVALID_VALUE' }); continue; }
        const mapped = FIELD_MAP[`${tabName}.${field}`]; if (!mapped) continue;
        const [defaultEntityType, internalField] = mapped;
        const entityType = tabName === 'TODAY' ? (normalized(baseline?.['Entity Type']) || defaultEntityType) : defaultEntityType;
        const identity = { spreadsheetId, tabName, entityId, field: internalField, questionId:normalized(baseline?.['Question ID']), before, value };
        accepted.push({
          actionKey: hashStable(JSON.stringify(identity)), spreadsheetId, tabName, entityType, entityId,
          field: internalField, value, observedAt, user, sourceHash: hashStable(JSON.stringify(row)),
          questionId: normalized(baseline?.['Question ID']), question: normalized(baseline?.Question),
        });
      }
    }
  }
  return { accepted, rejected };
}
