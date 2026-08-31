import { hashStable } from '../acquisition/normalize.mjs';
import { extractCandidateEvidence, validateCandidateIdentity } from '../research/enrichment-evidence.mjs';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const upperConfidence = value => String(value || 'LOW').toUpperCase();
function challengeCode(text) {
  if (/captcha/i.test(text)) return 'CAPTCHA';
  if (/sign in|log in|authentication required/i.test(text)) return 'AUTH_REQUIRED';
  if (/verify you are human|unusual traffic|security challenge|cloudflare/i.test(text)) return 'CHALLENGE';
  return null;
}
function googleUrl(query) { return `https://www.google.com/search?q=${encodeURIComponent(query)}`; }

export class BoundedApplicationResearchProvider {
  constructor({ browserAdapter = null, clock = () => new Date(), resolverVersion = 'application-research-1' } = {}) {
    this.browserAdapter = browserAdapter; this.clock = clock; this.resolverVersion = resolverVersion;
  }
  async research({ request, job, observation, plan } = {}) {
    const started = this.clock(); const evidence = []; const sources = [];this._contacts=[];
    const add = item => {
      const raw = clean(item.rawSnippet || (typeof item.value === 'string' ? item.value : JSON.stringify(item.value)));
      evidence.push({ ...item, id: item.id || `aev-${hashStable(`${item.sourceUrl}:${item.normalizedField}:${raw}`)}`, rawSnippet: raw.slice(0, 2000), rawHash: hashStable(raw), resolverVersion: this.resolverVersion });
    };
    if (clean(observation?.description)) add({ sourceUrl: observation.canonicalUrl || observation.sourceUrl || job.url, sourceType: 'REGISTRY_OBSERVATION', fetchedAt: observation.lastObservedAt || this.clock().toISOString(), extractionMethod: 'persisted_observation', normalizedField: 'description', value: observation.description, confidence: 'HIGH', identityStatus: 'CONFIRMED' });
    const persistedEmail=clean(observation?.description).match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0]?.toLowerCase();
    if(persistedEmail)add({sourceUrl:observation.canonicalUrl||observation.sourceUrl||job.url,sourceType:'REGISTRY_OBSERVATION',fetchedAt:observation.lastObservedAt||this.clock().toISOString(),extractionMethod:'persisted_public_text',normalizedField:'application_path',value:{email:persistedEmail},confidence:'HIGH',identityStatus:'CONFIRMED'});
    else if (job.url) add({ sourceUrl: job.url, sourceType: 'REGISTRY_OBSERVATION', fetchedAt: this.clock().toISOString(), extractionMethod: 'canonical_identity', normalizedField: 'application_path', value: { url: job.url }, confidence: 'HIGH', identityStatus: 'CONFIRMED' });
    if (!this.browserAdapter) { for(const task of plan.tasks.filter(item=>String(item.id||'').startsWith('contact-search')))sources.push({taskId:task.id,sourceType:task.sourceType,url:googleUrl(task.query),status:'BLOCKED',code:'BROWSER_UNAVAILABLE'});return this.finish({ started, evidence, sources, contacts: [], status: 'SUCCESS', coverLetterRequired: true }); }
    for (const task of plan.tasks.slice(0, plan.budget.maxPages)) {
      if (this.clock().getTime() - started.getTime() >= plan.budget.maxBrowserMinutes * 60_000) {
        sources.push({ taskId: task.id, sourceType: task.sourceType, url: task.url || '', status: 'BUDGET_EXHAUSTED', code: 'TIME_BUDGET_EXHAUSTED' });
        break;
      }
      const url = task.url || googleUrl(task.query);
      const source = { taskId: task.id, sourceType: task.sourceType, url, status: 'ATTEMPTED' }; sources.push(source);
      try {
        const page = await this.browserAdapter.read({ task: { ...task, url } });
        const block = challengeCode(page.text); if (block) { source.status = 'BLOCKED'; source.code = block; continue; }
        source.status = 'SUCCESS'; source.finalUrl = page.finalUrl;
        if (task.kind === 'JOB_PAGE') {
          const observedTitle = clean(page.title || page.findings?.find(item => item?.data?.title)?.data?.title);
          const observedCompany = clean(page.company || page.findings?.find(item => item?.data?.company)?.data?.company);
          const observedExternalId = clean(page.externalId || page.findings?.find(item => item?.data?.externalId)?.data?.externalId);
          const identity = validateCandidateIdentity(
            { canonicalUrl: job.url, externalId: job.externalId, title: job.title, company: job.company },
            { canonicalUrl: page.finalUrl, externalId: observedExternalId, title: observedTitle, company: observedCompany },
          );
          if (!identity.valid) { source.status = 'IDENTITY_UNCERTAIN'; source.code = identity.code; continue; }
          const extracted = extractCandidateEvidence({ canonicalUrl: page.finalUrl, detailUrl: page.finalUrl, title: job.title, company: job.company, fullDescription: page.text }, { source: task.sourceType, retrievedAt: page.retrievedAt });
          for (const item of extracted) add({ sourceUrl: item.sourceUrl, sourceType: task.sourceType, fetchedAt: item.retrievedAt, extractionMethod: item.extractionMethod, normalizedField: item.field === 'canonicalUrl' ? 'application_path' : item.field, value: item.field === 'canonicalUrl' ? { url: item.value } : item.value, confidence: upperConfidence(item.confidence), identityStatus: 'CONFIRMED' });
        } else if (new RegExp(job.company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(page.text)) {
          add({ sourceUrl: page.finalUrl, sourceType: task.sourceType, fetchedAt: page.retrievedAt, extractionMethod: 'page_text', normalizedField: task.id === 'company-search' ? 'company_context' : 'hiring_context', value: clean(page.text).slice(0, 4000), confidence: 'LOW', identityStatus: 'CONFIRMED' });
          if(task.id.startsWith('contact-search'))for(const candidate of page.contacts||page.findings?.filter(item=>item?.type==='PUBLIC_CONTACT').map(item=>item.data)||[]){const source={providerId:'bounded-public-research',providerVersion:'2.0',sourceType:'PUBLIC_PROFILE',sourceUrl:candidate.profileUrl||page.finalUrl,sourceHash:hashStable(`${candidate.name}:${candidate.role}:${candidate.profileUrl||page.finalUrl}`),retrievedAt:page.retrievedAt};const fields=[['name',candidate.name],['company',candidate.company||job.company],['role',candidate.role],['profile_url',candidate.profileUrl],['public_email',candidate.publicEmail],['other_public_route',candidate.otherPublicRoute]].filter(([,value])=>clean(value)).map(([field,value])=>({field,value,confidence:String(candidate.confidence||'MEDIUM').toUpperCase(),extractionMethod:'DIRECT',source}));if(fields.length>=3)this._contacts.push({ref:candidate.ref||hashStable(`${candidate.name}:${candidate.profileUrl||''}`),name:candidate.name,role:candidate.role,profileUrl:candidate.profileUrl||'',publicEmail:candidate.publicEmail||'',otherPublicRoute:candidate.otherPublicRoute||'',relationship:candidate.contactType||candidate.relationship||'UNKNOWN',evidence:fields,relationshipEvidence:candidate.relationshipEvidence||[]});}
        } else source.status = 'IDENTITY_UNCERTAIN';
      } catch (error) { source.status = 'UNAVAILABLE'; source.code = error.code || 'SOURCE_UNAVAILABLE'; source.detail = error.message; }
    }
    const successful = sources.filter(item => item.status === 'SUCCESS').length;
    const blocked = sources.filter(item => item.status === 'BLOCKED');
    return this.finish({ started, evidence, sources, contacts: this._contacts||[], status: blocked.length && !successful ? 'BLOCKED' : successful || evidence.length ? 'SUCCESS' : 'INSUFFICIENT_EVIDENCE', failureCode: blocked[0]?.code || null, coverLetterRequired: !evidence.some(item => item.normalizedField === 'cover_letter_required' && item.value === false) });
  }
  finish({ started, evidence, sources, contacts, status, failureCode = null, coverLetterRequired }) {
    const finished = this.clock();
    return { status, failureCode, evidence, contacts, coverLetterRequired, report: {
      version: '1', sourcesAttempted: sources, sourcesSuccessful: sources.filter(item => item.status === 'SUCCESS').length,
      sourcesBlocked: sources.filter(item => item.status === 'BLOCKED'), evidenceCount: evidence.length,
      contactsFound: contacts.length, descriptionComplete: evidence.some(item => item.normalizedField === 'description' && clean(item.value).length >= 500),
      applicationPathFound: evidence.some(item => item.normalizedField === 'application_path'),
      startedAt: started.toISOString(), finishedAt: finished.toISOString(), durationMs: Math.max(0, finished - started), usage: { llmCalls: 0, tokens: 0 },
    } };
  }
}

export class ResearchContactProvider {
  constructor({ researchResult, id = 'application-enrichment', version = '1' } = {}) { this.result = researchResult || {}; this.id = id; this.version = version; }
  async findCompany({ job, observation }) {
    return { name: job.company, evidence: [{ field: 'name', value: job.company, confidence: 'HIGH', extractionMethod: 'canonical_identity', sourceType: 'JOB_POSTING', sourceUrl: observation?.sourceUrl || observation?.canonicalUrl || job.url, retrievedAt: this.result.report?.finishedAt }] };
  }
  async findPeople() { return (this.result.contacts || []).map(item => ({ ...item, evidence: item.evidence || [] })); }
  async findRelationships({ people }) { return people.map(person => ({ personRef: person.ref || person.name, type: person.relationship || 'UNKNOWN', evidence: person.relationshipEvidence || [] })); }
  async getSearchReport(){const sources=this.result.report?.sourcesAttempted||[];const contactSources=sources.filter(item=>String(item.taskId||'').startsWith('contact-search'));const terminal=new Set(['SUCCESS','BLOCKED','UNAVAILABLE','IDENTITY_UNCERTAIN','BUDGET_EXHAUSTED']);return{completed:contactSources.length>0&&contactSources.every(item=>terminal.has(item.status)),bounded:true,sourcesSearched:contactSources.map(item=>({taskId:item.taskId,url:item.finalUrl||item.url,status:item.status})),queriesAttempted:contactSources.length,pagesInspected:contactSources.filter(item=>item.status==='SUCCESS').length,blocked:contactSources.length>0&&contactSources.every(item=>item.status==='BLOCKED'),finishedAt:this.result.report?.finishedAt||null};}
}
