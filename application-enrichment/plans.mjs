import { APPLICATION_PATH_TYPES } from './contracts.mjs';

const clean = value => String(value || '').trim();
function pathType(url, email = '') {
  if (email) return 'EMAIL';
  let host = ''; try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (/greenhouse|lever|ashbyhq|workday|smartrecruiters|icims|jobvite/.test(host)) return 'ATS';
  if (/linkedin|indeed|wellfound|remoteok|jobicy/.test(host)) return 'PLATFORM';
  return url ? 'OTHER' : 'UNKNOWN';
}
function canonicalApplicationUrl(value) {
  const url = clean(value); if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() === 'jobs.ashbyhq.com' && !/\/application\/?$/i.test(parsed.pathname)) {
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/application`;
      parsed.hash = '';
      return parsed.toString();
    }
  } catch {}
  return url;
}

export function discoverApplicationPath({ job, evidence = [] } = {}) {
  const explicit = evidence.filter(item => item.normalizedField === 'application_path' && item.identityStatus !== 'UNCERTAIN').at(-1);
  const value = explicit?.value || explicit?.valueJson || job?.canonicalUrl || job?.sourceUrl || job?.url || '';
  const raw = typeof value === 'object' ? value : { url: value };
  const email = clean(raw.email || (clean(raw.url).match(/mailto:([^?]+)/i) || [])[1]);
  const url = email ? '' : canonicalApplicationUrl(raw.url || raw.value || value);
  const primaryPath = pathType(url, email);
  return {
    version: '1', status: primaryPath === 'UNKNOWN' ? 'MISSING' : 'READY',
    primaryPath: APPLICATION_PATH_TYPES.includes(primaryPath) ? primaryPath : 'UNKNOWN',
    primaryAction: email ? `Prepare email to ${email}` : url ? `Apply through ${primaryPath}` : 'Confirm application instructions manually',
    url, email, sourceEvidenceIds: explicit ? [explicit.id] : [], instructions: clean(raw.instructions),
    alternativePaths: [], specialInstructions: [], manualRequirements: primaryPath === 'UNKNOWN' ? ['Confirm the official application channel'] : [], risks: [],
  };
}

export function buildContactPlan({ contactResearch = null, packageArtifact = null } = {}) {
  const relationships = contactResearch?.relationships || [];
  const people = new Map((contactResearch?.people || []).map(item => [item.ref, item]));
  const preferred = [
    'RECRUITER', 'TALENT_ACQUISITION', 'HIRING_MANAGER', 'TEAM_LEAD',
    'FUNCTIONAL_LEADER', 'ENGINEERING_MANAGER', 'SOLUTIONS_LEADER', 'FOUNDER',
    'OTHER_RELEVANT', 'GENERAL_RECRUITING',
    // Legacy relationship types remain readable for existing records.
    'ENGINEERING_LEAD', 'TEAM_MEMBER', 'COMPANY_CONTACT',
  ];
  const relation = preferred.map(type => relationships.find(item => item.type === type && item.status === 'CONFIRMED')).find(Boolean);
  const person = relation ? people.get(relation.personRef) : null;
  const draftType = relation?.type === 'HIRING_MANAGER' ? 'HIRING_MANAGER_MESSAGE' : 'RECRUITER_MESSAGE';
  const draft = (packageArtifact?.artifacts?.outreach || []).find(item => item.type === draftType) || null;
  return relation && person ? {
    version: '1', status: 'READY', recommended: true, target: person.name, relationship: relation.type,
    channel: person.profileUrl ? 'LINKEDIN' : 'PUBLIC_CONTACT', profileUrl: person.profileUrl || '',
    reason: relation.rationale, evidenceRefs: (relation.evidence || []).map(item => item.id), draft: draft?.content || '',
  } : { version: '1', status: 'NO_EVIDENCED_CONTACT', recommended: false, target: '', relationship: 'UNKNOWN', channel: 'NONE', reason: 'No identity-validated public contact was found.', evidenceRefs: [], draft: '' };
}
