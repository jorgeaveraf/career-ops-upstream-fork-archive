export const ENRICHMENT_RESULT_STATUSES = Object.freeze(['COMPLETE', 'PARTIAL', 'NONE_FOUND', 'BLOCKED', 'NOT_RUN']);
export const CONTACT_RESEARCH_STATUSES = Object.freeze(['COMPLETE_WITH_CONTACT', 'COMPLETE_NONE_VERIFIED', 'BLOCKED', 'NOT_RUN', 'FOUND', 'NONE_FOUND']);

const attempted = source => ['SUCCESS', 'BLOCKED', 'UNAVAILABLE', 'IDENTITY_UNCERTAIN', 'BUDGET_EXHAUSTED'].includes(source?.status);
const statusForSources = sources => {
  if (!sources.length) return 'NOT_RUN';
  if (sources.some(source => source.status === 'SUCCESS')) return sources.some(source => source.status !== 'SUCCESS') ? 'PARTIAL' : 'COMPLETE';
  if (sources.some(source => source.status === 'BLOCKED')) return 'BLOCKED';
  return sources.some(attempted) ? 'NONE_FOUND' : 'NOT_RUN';
};

export function buildEnrichmentCompletion({ report = {}, evidence = [], contactResearch = null, applicationPlan = null, finishedAt = null } = {}) {
  const sources = Array.isArray(report.sourcesAttempted) ? report.sourcesAttempted : [];
  const jobSources = sources.filter(source => source.sourceType === 'CANONICAL_JOB_PAGE');
  const companySources = sources.filter(source => source.taskId === 'company-search' || source.sourceType === 'COMPANY_PAGE');
  const hiringSources = sources.filter(source => String(source.taskId || '').startsWith('contact-search') || source.sourceType === 'LINKEDIN_PUBLIC');
  const contacts = (contactResearch?.relationships || []).filter(item => item.status === 'CONFIRMED' && item.type !== 'UNKNOWN');
  const contactStatus = contactResearch
    ? (contactResearch.completionStatus || (contacts.length ? 'COMPLETE_WITH_CONTACT' : 'NOT_RUN'))
    : (report.contactResearchBlocked ? 'BLOCKED' : 'NOT_RUN');
  const applicationPath = applicationPlan?.status === 'READY' ? 'COMPLETE'
    : applicationPlan ? 'NONE_FOUND' : sources.some(source => source.status === 'BLOCKED') ? 'BLOCKED' : 'NOT_RUN';
  const sourceUrls = [...new Set(evidence.map(item => item.sourceUrl).filter(Boolean))];
  return {
    version: '2.1',
    jobResearch: report.descriptionComplete || evidence.some(item => item.normalizedField === 'description') ? 'COMPLETE' : statusForSources(jobSources),
    companyResearch: evidence.some(item => item.normalizedField === 'company_context') ? 'COMPLETE' : statusForSources(companySources),
    hiringResearch: evidence.some(item => item.normalizedField === 'hiring_context') ? 'COMPLETE' : statusForSources(hiringSources),
    contactResearch: contactStatus,
    applicationPathResearch: applicationPath,
    evidenceCount: evidence.length,
    sourceCount: sourceUrls.length,
    sources: sourceUrls,
    lastEnriched: finishedAt || report.finishedAt || '',
  };
}

export function isEnrichmentCompletionRecord(value) {
  return Boolean(value && value.version && ENRICHMENT_RESULT_STATUSES.includes(value.jobResearch)
    && ENRICHMENT_RESULT_STATUSES.includes(value.companyResearch)
    && ENRICHMENT_RESULT_STATUSES.includes(value.hiringResearch)
    && CONTACT_RESEARCH_STATUSES.includes(value.contactResearch)
    && ENRICHMENT_RESULT_STATUSES.includes(value.applicationPathResearch)
    && Number.isInteger(value.evidenceCount) && Number.isInteger(value.sourceCount) && value.lastEnriched);
}

export function enrichmentSummary(value = {}) {
  if (!isEnrichmentCompletionRecord(value)) return 'NOT_RUN';
  return `Job ${value.jobResearch} · Company ${value.companyResearch} · Hiring ${value.hiringResearch} · Contacts ${value.contactResearch} · Path ${value.applicationPathResearch} · ${value.evidenceCount} evidence / ${value.sourceCount} sources`;
}
