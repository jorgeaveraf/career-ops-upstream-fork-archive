import { hashStable } from '../acquisition/normalize.mjs';
import { DEFAULT_APPLICATION_RESEARCH_BUDGET } from './contracts.mjs';

const GAP_DIMENSIONS = Object.freeze({
  FETCH_FULL_DESCRIPTION: 'job_description', CONFIRM_MEXICO_ELIGIBILITY: 'geography',
  CONFIRM_REMOTE_SCOPE: 'geography', RESOLVE_LOCATION_CONFLICT: 'geography',
  CONFIRM_EMPLOYMENT_MODEL: 'employment_model', CONFIRM_COMPENSATION: 'compensation',
  CONFIRM_COMPANY_MARKET: 'company_context', CONFIRM_SCHEDULE: 'schedule',
  CONFIRM_POSTING_STATUS: 'posting_freshness', CONFIRM_POSTING_IS_REAL: 'posting_freshness',
});
const clean = value => String(value || '').trim();
function contactQueries(job={}) { const company=clean(job.company),title=clean(job.title),roleFamily=/solutions|sales engineer|presales/i.test(title)?'solutions engineering':/data/i.test(title)?'data engineering':/ai|machine learning|ml/i.test(title)?'AI engineering':'engineering';return[
  `${company} recruiter ${title}`,
  `${company} talent acquisition ${roleFamily}`,
  `${company} ${title} hiring manager`,
  `${company} ${roleFamily} manager lead`,
  `${company} recruiting careers contact`,
]; }

export function buildApplicationResearchPlan({ request, job, observation, budget = {} } = {}) {
  const bounded = { ...DEFAULT_APPLICATION_RESEARCH_BUDGET, ...budget };
  const openNeeds = request?.researchState?.openNeeds || [];
  const dimensions = [...new Set(openNeeds.map(item => GAP_DIMENSIONS[item.type] || item.dimension).filter(Boolean))];
  if (clean(observation?.description).length < 500 && !dimensions.includes('job_description')) dimensions.unshift('job_description');
  for (const dimension of ['company_context', 'application_path', 'hiring_contacts']) if (!dimensions.includes(dimension)) dimensions.push(dimension);
  const canonicalUrl = clean(job?.canonicalUrl || job?.sourceUrl || job?.url || observation?.canonicalUrl || observation?.sourceUrl);
  const tasks = [];
  if (canonicalUrl) tasks.push({ id: 'canonical-job', kind: 'JOB_PAGE', sourceType: 'CANONICAL_JOB_PAGE', url: canonicalUrl, dimensions: dimensions.filter(item => item !== 'hiring_contacts') });
  const companyQuery = `${clean(job?.company)} careers about team`;
  if (bounded.maxSearchQueries > 0) tasks.push({ id: 'company-search', kind: 'PUBLIC_SEARCH', sourceType: 'PUBLIC_WEB', query: companyQuery, dimensions: ['company_context', 'hiring_context'] });
  for(const [index,query] of contactQueries(job).slice(0,Math.max(0,bounded.maxSearchQueries-1)).entries())tasks.push({id:`contact-search-${index+1}`,kind:'PUBLIC_SEARCH',sourceType:'PUBLIC_WEB',query,dimensions:['hiring_contacts']});
  const plan = {
    version: '1', requestId: request?.id, jobId: request?.jobId || job?.id,
    existing: { descriptionComplete: clean(observation?.description).length >= 500, openNeeds: openNeeds.map(item => item.type) },
    dimensions, sourceOrder: ['CANONICAL_ATS', 'ORIGINAL_POSTING', 'COMPANY_WEBSITE', 'COMPANY_CAREERS_ABOUT_TEAM', 'LINKEDIN_PUBLIC', 'PUBLIC_WEB', 'FACEBOOK_PUBLIC_WHEN_RELEVANT', 'INSTAGRAM_PUBLIC_WHEN_RELEVANT', 'OTHER_TRUSTED_PUBLIC'],
    tasks: tasks.slice(0, bounded.maxPages), budget: bounded,
  };
  return { ...plan, planHash: hashStable(JSON.stringify(plan)) };
}
