import { hashStable } from '../acquisition/normalize.mjs';
import {
  CONTACT_INTELLIGENCE_ARTIFACT_VERSION, CONTACT_INTELLIGENCE_ENGINE_VERSION,
  RELATIONSHIP_TYPES,
} from './contracts.mjs';
import {
  evidenceFor, highestConfidence, normalizeDomain, normalizeEvidence,
  normalizeIdentity, normalizePublicUrl, normalizeText, stableSourceHash,
} from './normalize.mjs';

function valuesFromEvidence(evidence, field) {
  return evidenceFor(evidence, field).flatMap(item => Array.isArray(item.value) ? item.value : [item.value]);
}

function evidencedValue(input, evidence, field, normalizer = normalizeText) {
  const supported = evidenceFor(evidence, field);
  if (!supported.length) return null;
  const requested = normalizer(input);
  const match = supported.find(item => normalizer(item.value) === requested) || supported[0];
  return normalizer(match.value) || null;
}

function normalizePublicEmail(value) {
  const email = normalizeText(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function companyFrom(job, observation, providerResult, provider, at) {
  const jobName = normalizeText(observation?.company || job.company);
  const jobUrl = normalizePublicUrl(observation?.canonicalUrl || observation?.sourceUrl || job.canonicalUrl || job.sourceUrl);
  const jobHash = normalizeText(observation?.contentHash || observation?.snapshotHash) || hashStable(JSON.stringify({ jobName, jobUrl, jobId: job.id || job.jobId }));
  const jobEvidence = jobName ? [normalizeEvidence({
    field: 'name', value: jobName, confidence: 'HIGH', extractionMethod: 'DIRECT',
    source: { providerId: 'job-registry', sourceType: 'JOB_POSTING', sourceUrl: jobUrl || undefined, sourceHash: jobHash, retrievedAt: observation?.retrievedAt || at },
  })].filter(Boolean) : [];
  const suppliedEvidence = (providerResult?.evidence || []).map(item => normalizeEvidence(item, {
    providerId: provider?.id, providerVersion: provider?.version, retrievedAt: at,
  })).filter(Boolean);
  const evidence = [...new Map([...jobEvidence, ...suppliedEvidence].map(item => [item.id, item])).values()];
  const raw = providerResult?.company || providerResult || {};
  const name = jobName || evidencedValue(raw.name, evidence, 'name');
  if (!name) throw new Error('company name requires job or provider evidence');
  const scalar = field => evidencedValue(raw[field], evidence, field);
  const urls = [...new Set(valuesFromEvidence(evidence, 'relevant_urls').map(normalizePublicUrl).filter(Boolean))].sort();
  const result = {
    name, normalizedName: normalizeIdentity(name),
    domain: evidencedValue(raw.domain, evidence, 'domain', normalizeDomain),
    relevantUrls: urls,
    careersUrl: evidencedValue(raw.careersUrl || raw.careers_url, evidence, 'careers_url', normalizePublicUrl),
    description: scalar('description'), industry: scalar('industry'),
    products: valuesFromEvidence(evidence, 'products').map(normalizeText).filter(Boolean),
    visibleTechnologies: valuesFromEvidence(evidence, 'visible_technologies').map(normalizeText).filter(Boolean),
    publicCulture: valuesFromEvidence(evidence, 'public_culture').map(normalizeText).filter(Boolean),
    evidence,
  };
  result.confidence = highestConfidence(evidenceFor(evidence, 'name').map(item => item.confidence));
  return result;
}

function personFrom(raw, company, provider, at) {
  const evidence = (raw?.evidence || []).map(item => normalizeEvidence(item, {
    providerId: provider?.id, providerVersion: provider?.version, retrievedAt: at,
  })).filter(Boolean);
  const name = evidencedValue(raw?.name, evidence, 'name');
  const role = evidencedValue(raw?.role, evidence, 'role');
  const profileUrl = evidencedValue(raw?.profileUrl || raw?.profile_url, evidence, 'profile_url', normalizePublicUrl);
  const publicEmail = evidencedValue(raw?.publicEmail || raw?.public_email, evidence, 'public_email', normalizePublicEmail);
  const otherPublicRoute = evidencedValue(raw?.otherPublicRoute || raw?.other_public_route, evidence, 'other_public_route', normalizePublicUrl);
  const companyEvidence = evidenceFor(evidence, 'company');
  const confirmedCompany = companyEvidence.some(item => [company.normalizedName, company.domain].filter(Boolean).includes(normalizeIdentity(item.value)) || normalizeText(item.value).toLowerCase() === company.domain);
  const confirmed = Boolean(name && evidenceFor(evidence, 'name').length && confirmedCompany);
  const displayName = name || normalizeText(raw?.name) || 'Unknown person';
  const ref = normalizeText(raw?.ref || raw?.id) || `person:${hashStable(JSON.stringify({ name: normalizeIdentity(displayName), company: company.normalizedName, profileUrl }))}`;
  return {
    ref, name: displayName, normalizedName: normalizeIdentity(displayName), companyName: confirmed ? company.name : null,
    role, profileUrl, publicEmail, otherPublicRoute, status: confirmed ? 'CONFIRMED' : 'UNKNOWN',
    confidence: confirmed ? highestConfidence(evidence.map(item => item.confidence)) : 'LOW', evidence,
  };
}

function roleRelationship(person) {
  if (person.status === 'UNKNOWN' || !person.role) return { type: 'UNKNOWN', confidence: 'LOW', rationale: 'Insufficient evidenced identity or role.' };
  const role = normalizeIdentity(person.role);
  if (/\brecruiter\b/.test(role)) return { type: 'RECRUITER', confidence: 'HIGH', rationale: 'The evidenced role explicitly identifies recruiting responsibility.' };
  if (/\btalent acquisition\b/.test(role)) return { type: 'TALENT_ACQUISITION', confidence: 'HIGH', rationale: 'The evidenced role explicitly identifies talent acquisition responsibility.' };
  if (/\bhiring manager\b/.test(role)) return { type: 'HIRING_MANAGER', confidence: 'HIGH', rationale: 'The evidenced role explicitly says hiring manager.' };
  if (/\b(founder|co founder|ceo)\b/.test(role)) return { type: 'FOUNDER', confidence: 'MEDIUM', rationale: 'The evidenced title identifies company leadership; direct ownership of this role is not proven.' };
  if (/\bsolutions?\b.*\b(manager|director|lead|head|vp|vice president)\b|\b(manager|director|lead|head|vp|vice president)\b.*\bsolutions?\b/.test(role)) return { type: 'SOLUTIONS_LEADER', confidence: 'MEDIUM', rationale: 'The evidenced title is relevant solutions leadership.' };
  if (/\bengineering manager\b/.test(role)) return { type: 'ENGINEERING_MANAGER', confidence: 'MEDIUM', rationale: 'The evidenced title is an engineering manager; job-specific ownership is not proven.' };
  if (/\b(team lead|technical lead|tech lead)\b/.test(role)) return { type: 'TEAM_LEAD', confidence: 'MEDIUM', rationale: 'The evidenced title indicates team leadership.' };
  if (/\b(engineering|technical)\b.*\b(manager|director|lead|head|vp|vice president)\b|\b(manager|director|lead|head|vp|vice president)\b.*\b(engineering|technical)\b/.test(role)) {
    return { type: 'ENGINEERING_LEAD', confidence: 'MEDIUM', rationale: 'The evidenced title indicates engineering leadership, not hiring ownership.' };
  }
  if (/\b(engineer|engineering|developer|team member)\b/.test(role)) return { type: 'TEAM_MEMBER', confidence: 'LOW', rationale: 'The evidenced role indicates team membership only.' };
  if (/\b(head|director|vp|vice president|chief)\b/.test(role)) return { type: 'FUNCTIONAL_LEADER', confidence: 'MEDIUM', rationale: 'The evidenced title indicates relevant functional leadership.' };
  return { type: 'COMPANY_CONTACT', confidence: 'LOW', rationale: 'Evidence supports company affiliation but no job-specific relationship.' };
}

function relationshipFrom(person, supplied, provider, at) {
  const evidence = (supplied?.evidence || []).map(item => normalizeEvidence(item, {
    providerId: provider?.id, providerVersion: provider?.version, retrievedAt: at,
  })).filter(Boolean);
  const requested = normalizeText(supplied?.type).toUpperCase();
  const direct = evidenceFor(evidence, 'relationship').find(item => normalizeText(item.value).toUpperCase() === requested);
  if (direct && RELATIONSHIP_TYPES.includes(requested)) {
    return { personRef: person.ref, type: requested, confidence: direct.confidence, status: requested === 'UNKNOWN' ? 'UNKNOWN' : 'CONFIRMED', evidence, rationale: 'Relationship type is directly supported by source evidence.' };
  }
  const derived = roleRelationship(person);
  return { personRef: person.ref, ...derived, status: derived.type === 'UNKNOWN' ? 'UNKNOWN' : 'CONFIRMED', evidence: evidenceFor(person.evidence, 'role') };
}

function strategyFor(relationships) {
  const order = ['RECRUITER', 'HIRING_MANAGER', 'TEAM_LEAD', 'TALENT_ACQUISITION', 'ENGINEERING_MANAGER', 'SOLUTIONS_LEADER', 'FUNCTIONAL_LEADER', 'FOUNDER', 'GENERAL_RECRUITING', 'ENGINEERING_LEAD', 'TEAM_MEMBER', 'OTHER_RELEVANT', 'COMPANY_CONTACT'];
  const confirmed = order.filter(type => relationships.some(item => item.type === type));
  const recommendedPath = [...confirmed.slice(0, 2), 'DIRECT_APPLICATION'];
  const strongest = relationships.find(item => item.confidence === 'HIGH') || relationships.find(item => item.confidence === 'MEDIUM');
  return {
    recommendedPath,
    reasoning: confirmed.length
      ? recommendedPath.map(type => type === 'DIRECT_APPLICATION' ? 'Keep the official application channel as the human-controlled fallback.' : `${type} is supported by recorded public evidence.`)
      : ['No supported person relationship was identified; use the official application channel after human review.'],
    confidence: strongest?.confidence || 'LOW',
  };
}

const CONTACT_ORDER = Object.freeze({ RECRUITER:0, HIRING_MANAGER:1, TEAM_LEAD:2, TALENT_ACQUISITION:3, ENGINEERING_MANAGER:4, SOLUTIONS_LEADER:5, FUNCTIONAL_LEADER:6, FOUNDER:7, GENERAL_RECRUITING:8, ENGINEERING_LEAD:9, TEAM_MEMBER:10, OTHER_RELEVANT:11, COMPANY_CONTACT:12, UNKNOWN:99 });
const CONFIDENCE_ORDER = Object.freeze({ HIGH:0, MEDIUM:1, LOW:2 });
function rankedContacts(people,relationships){const byPerson=new Map(people.map(person=>[person.ref,person]));return relationships.filter(item=>item.status==='CONFIRMED'&&item.type!=='UNKNOWN').map(item=>({person:byPerson.get(item.personRef),relationship:item})).filter(item=>item.person).sort((a,b)=>(CONTACT_ORDER[a.relationship.type]??98)-(CONTACT_ORDER[b.relationship.type]??98)||(CONFIDENCE_ORDER[a.relationship.confidence]??9)-(CONFIDENCE_ORDER[b.relationship.confidence]??9)||a.person.name.localeCompare(b.person.name)).map((item,index)=>({resultType:item.relationship.type==='GENERAL_RECRUITING'?'GENERAL_RECRUITING':index===0?'PRIMARY_CONTACT':'SECONDARY_CONTACT',name:item.person.name,role:item.person.role,contactType:item.relationship.type==='COMPANY_CONTACT'?'OTHER_RELEVANT':item.relationship.type,whyRelevant:item.relationship.rationale,publicProfileUrl:item.person.profileUrl||'',publicEmail:item.person.publicEmail||'',otherPublicRoute:item.person.otherPublicRoute||'',confidence:item.relationship.confidence,source:(item.relationship.evidence[0]||item.person.evidence[0])?.source||null,verifiedAt:(item.relationship.evidence[0]||item.person.evidence[0])?.source?.retrievedAt||null,personRef:item.person.ref}));}

export class ContactIntelligenceEngine {
  constructor({ provider = null, engineVersion = CONTACT_INTELLIGENCE_ENGINE_VERSION, clock = () => new Date() } = {}) {
    this.provider = provider;
    this.engineVersion = String(engineVersion);
    this.clock = clock;
  }

  async research({ job, observation = null, applicationPackage = null } = {}) {
    if (!job || !String(job.id || job.jobId || '').trim()) throw new TypeError('job with id is required');
    if (applicationPackage && applicationPackage.jobId !== (job.id || job.jobId)) throw new Error('application package must belong to the researched job');
    if (applicationPackage && (applicationPackage.validationStatus !== 'VALID' || !['DRAFT', 'APPROVED'].includes(applicationPackage.status))) {
      throw new Error('contact research requires a VALID DRAFT or APPROVED application package');
    }
    const researchedAt = this.clock().toISOString();
    const context = Object.freeze({ job, observation, applicationPackage });
    const companyResult = this.provider ? await this.provider.findCompany(context) : null;
    const company = companyFrom(job, observation, companyResult, this.provider, researchedAt);
    const peopleResult = this.provider ? await this.provider.findPeople({ ...context, company }) : [];
    const people = (Array.isArray(peopleResult) ? peopleResult : peopleResult?.people || []).map(item => personFrom(item, company, this.provider, researchedAt));
    const relationshipResult = this.provider ? await this.provider.findRelationships({ ...context, company, people }) : [];
    const suppliedRelationships = Array.isArray(relationshipResult) ? relationshipResult : relationshipResult?.relationships || [];
    const relationships = people.map(person => {
      const supplied = suppliedRelationships.find(item => normalizeText(item.personRef || item.person_ref) === person.ref) || null;
      return relationshipFrom(person, supplied, this.provider, researchedAt);
    });
    const allEvidence = [...company.evidence, ...people.flatMap(item => item.evidence), ...relationships.flatMap(item => item.evidence)];
    const sourceHash = stableSourceHash([...new Map(allEvidence.map(item => [item.id, item])).values()]);
    const contacts=rankedContacts(people,relationships);const searchReport=await this.provider?.getSearchReport?.(context)||null;const completionStatus=contacts.length?'COMPLETE_WITH_CONTACT':searchReport?.blocked?'BLOCKED':searchReport?.completed?'COMPLETE_NONE_VERIFIED':'NOT_RUN';
    const identity = {
      jobId: job.id || job.jobId, applicationPackageId: applicationPackage?.id || null,
      sourceHash, engineVersion: this.engineVersion,
      providerId: this.provider?.id || 'none', providerVersion: this.provider?.version || 'none',
    };
    return {
      artifactVersion: CONTACT_INTELLIGENCE_ARTIFACT_VERSION,
      researchKey: hashStable(JSON.stringify(identity)), jobId: identity.jobId,
      applicationPackageId: identity.applicationPackageId,
      status: 'CONTACT_INTELLIGENCE_READY', completionStatus,reviewStatus: 'HUMAN_REVIEW_REQUIRED',
      resultStatus:contacts[0]?.resultType||(searchReport?.blocked?'BLOCKED':searchReport?.completed?'NONE_VERIFIED':'BLOCKED'),primaryContact:contacts.find(item=>item.resultType==='PRIMARY_CONTACT')||null,contacts:contacts.slice(0,5),
      searchReport:searchReport||{completed:true,sourcesSearched:[],queriesAttempted:0,pagesInspected:0,bounded:true},
      company, people, relationships, outreachStrategy: strategyFor(relationships), sourceHash,
      provenance: { engineVersion: this.engineVersion, providerId: identity.providerId, providerVersion: identity.providerVersion },
      researchedAt,
    };
  }
}
