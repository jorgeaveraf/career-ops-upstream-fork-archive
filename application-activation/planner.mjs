import { hashStable } from '../acquisition/normalize.mjs';
import { APPLICATION_ACTIVATION_VERSION } from './contracts.mjs';

const clean = value => String(value ?? '').trim();
const upper = value => clean(value).toUpperCase();
const CONTACT_PRIORITY = Object.freeze({
  RECRUITER: 0, HIRING_MANAGER: 1, TEAM_LEAD: 2, TALENT_ACQUISITION: 3,
  ENGINEERING_MANAGER: 4, SOLUTIONS_LEADER: 5, FUNCTIONAL_LEADER: 6,
  FOUNDER: 7, GENERAL_RECRUITING: 8, OTHER_RELEVANT: 9,
  ENGINEERING_LEAD: 10, TEAM_MEMBER: 11, COMPANY_CONTACT: 12,
});
const CONFIDENCE_PRIORITY = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2 });

function normalizedContacts(contactIntelligence = {}) {
  const contacts = Array.isArray(contactIntelligence.contacts) ? contactIntelligence.contacts : [];
  return contacts.filter(contact => contact && clean(contact.name)).map(contact => ({
    contactId: clean(contact.personRef || contact.id || hashStable(JSON.stringify(contact))),
    name: clean(contact.name), title: clean(contact.role), contactType: upper(contact.contactType || contact.resultType),
    whyRelevant: clean(contact.whyRelevant), confidence: upper(contact.confidence) || 'LOW',
    publicProfileUrl: clean(contact.publicProfileUrl), publicEmail: clean(contact.publicEmail).toLowerCase(),
    otherPublicRoute: clean(contact.otherPublicRoute), source: contact.source || null,
    verifiedAt: clean(contact.verifiedAt), resultType: upper(contact.resultType),
  })).filter(contact => !contact.publicEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.publicEmail))
    .sort((a, b) => (CONTACT_PRIORITY[a.contactType] ?? 98) - (CONTACT_PRIORITY[b.contactType] ?? 98)
      || (CONFIDENCE_PRIORITY[a.confidence] ?? 9) - (CONFIDENCE_PRIORITY[b.confidence] ?? 9)
      || a.name.localeCompare(b.name));
}

function channelFor(contact, capabilities = {}) {
  if (!contact) return 'NONE';
  if (contact.contactType === 'GENERAL_RECRUITING' && contact.publicEmail) return 'GENERAL_RECRUITING';
  if (contact.contactType === 'GENERAL_RECRUITING' && contact.otherPublicRoute) return 'PLATFORM_MESSAGE';
  if (contact.publicEmail && ['RECRUITER', 'TALENT_ACQUISITION'].includes(contact.contactType)) return 'RECRUITER_EMAIL';
  if (contact.publicEmail && ['HIRING_MANAGER', 'TEAM_LEAD', 'ENGINEERING_MANAGER', 'SOLUTIONS_LEADER', 'FUNCTIONAL_LEADER'].includes(contact.contactType)) return 'HIRING_MANAGER_EMAIL';
  if (contact.publicProfileUrl) {
    try { if (/(^|\.)linkedin\.com$/i.test(new URL(contact.publicProfileUrl).hostname)) return 'LINKEDIN_PROFILE'; } catch {}
  }
  if (contact.publicProfileUrl) return 'PLATFORM_MESSAGE';
  if (contact.otherPublicRoute) return 'PLATFORM_MESSAGE';
  if (contact.otherPublicRoute && contact.contactType === 'GENERAL_RECRUITING') return 'GENERAL_RECRUITING';
  return 'NONE';
}

function strategyFor(contact, channel, contactIntelligence) {
  if (upper(contactIntelligence?.completionStatus) === 'BLOCKED') return 'OUTREACH_BLOCKED';
  if (!contact || channel === 'NONE') return 'NO_OUTREACH';
  if (channel === 'PLATFORM_MESSAGE') return 'MANUAL_OUTREACH_RECOMMENDED';
  if (contact.contactType === 'GENERAL_RECRUITING') return 'OUTREACH_OPTIONAL';
  if (['RECRUITER', 'HIRING_MANAGER', 'TALENT_ACQUISITION'].includes(contact.contactType)
    && ['HIGH', 'MEDIUM'].includes(contact.confidence)) return 'OUTREACH_RECOMMENDED';
  if (['TEAM_LEAD', 'ENGINEERING_MANAGER', 'SOLUTIONS_LEADER'].includes(contact.contactType)
    && contact.confidence === 'HIGH') return 'OUTREACH_RECOMMENDED';
  if (['LOW'].includes(contact.confidence) || ['TEAM_MEMBER', 'COMPANY_CONTACT', 'OTHER_RELEVANT'].includes(contact.contactType)) return 'NO_OUTREACH';
  return 'OUTREACH_OPTIONAL';
}

function selectDraft(packageRecord, contactType, channel) {
  const drafts = packageRecord?.artifacts?.outreach || [];
  const type = channel === 'HIRING_MANAGER_EMAIL' || ['HIRING_MANAGER', 'TEAM_LEAD', 'ENGINEERING_MANAGER', 'SOLUTIONS_LEADER'].includes(contactType)
    ? 'HIRING_MANAGER_MESSAGE' : channel === 'GENERAL_RECRUITING' || channel.endsWith('_EMAIL') ? 'EMAIL_INTRODUCTION' : 'RECRUITER_MESSAGE';
  return drafts.find(item => item.type === type) || drafts.find(item => item.type === 'RECRUITER_MESSAGE') || null;
}

function linkedinBody(body, job, company) {
  let value = clean(body).replace(/\s+/g, ' ');
  if (value.length < 300) value += ` I’m preparing a focused application for ${clean(job.title)} at ${clean(company.name || job.company)} and would value the right next step for the hiring team.`;
  if (value.length > 500) value = `${value.slice(0, 497).trimEnd()}…`;
  return value;
}

function emailBody(body, job, company) {
  let value = clean(body);
  const words = () => value.split(/\s+/).filter(Boolean).length;
  if (words() < 60) value += `\n\nI’m preparing a focused application through the official route and wanted to share the most relevant context directly. If this background aligns with what the team needs, I’d appreciate guidance on the appropriate next step.`;
  if (words() > 120) value = value.split(/\s+/).slice(0, 120).join(' ');
  return value.replaceAll('{ROLE}', clean(job.title)).replaceAll('{COMPANY}', clean(company.name || job.company));
}

function publicTarget(contact, channel) {
  if (!contact) return '';
  if (channel.endsWith('_EMAIL')) return contact.publicEmail;
  if (channel === 'LINKEDIN_PROFILE') return contact.publicProfileUrl;
  return contact.otherPublicRoute || contact.publicEmail || contact.publicProfileUrl;
}

export class ApplicationActivationPlanner {
  constructor({ clock = () => new Date() } = {}) { this.clock = clock; }

  plan({ job = {}, evaluation = {}, applicationPath = {}, packageRecord = null,
    contactIntelligence = null, companyResearch = {}, hiringResearch = {}, sourceProvenance = {},
    candidatePreferences = {}, channelCapabilities = {} } = {}) {
    const contacts = normalizedContacts(contactIntelligence || {});
    const primaryContact = contacts[0] || null;
    const secondaryContact = contacts.find((contact, index) => index > 0 && contact.confidence === 'HIGH') || null;
    const channel = channelFor(primaryContact, channelCapabilities);
    let outreachStrategy = strategyFor(primaryContact, channel, contactIntelligence);
    if(upper(applicationPath.primaryPath)==='EMAIL'&&primaryContact?.publicEmail&&primaryContact.publicEmail===clean(applicationPath.email).toLowerCase())outreachStrategy='NO_OUTREACH';
    const outreachRelevant = ['OUTREACH_RECOMMENDED', 'OUTREACH_OPTIONAL','MANUAL_OUTREACH_RECOMMENDED'].includes(outreachStrategy);
    const authorizationRelevant=['OUTREACH_RECOMMENDED','OUTREACH_OPTIONAL'].includes(outreachStrategy);
    const timing = outreachRelevant ? 'IMMEDIATELY_AFTER_APPLICATION' : 'NONE';
    const sourceDraft = outreachRelevant ? selectDraft(packageRecord, primaryContact?.contactType, channel) : null;
    const body = !sourceDraft ? '' : ['LINKEDIN_PROFILE','PLATFORM_MESSAGE'].includes(channel)
      ? linkedinBody(sourceDraft.content, job, companyResearch)
      : emailBody(sourceDraft.content, job, companyResearch);
    const applicationStrategy = {
      status: upper(applicationPath.status) === 'READY' ? 'APPLICATION_READY' : 'APPLICATION_BLOCKED',
      primaryChannel: upper(applicationPath.primaryPath) || 'UNKNOWN', applicationUrl: clean(applicationPath.url),
      applicationEmail: clean(applicationPath.email), packageId: packageRecord?.id || null,
      packageVersion: packageRecord?.packageVersion ?? null,
      requiredArtifacts: packageRecord ? ['resume.pdf'] : [],
      requiredQuestions: applicationPath.manualRequirements || [], knownBlockers: applicationPath.risks || [],
    };
    const draftCore = {
      jobId: clean(job.id || job.jobId), applicationId: null, contactId: primaryContact?.contactId || null,
      channel, timing, subject: clean(sourceDraft?.subject) || (outreachRelevant ? `${clean(job.title)} — Jorge Vera` : ''),
      body, evidenceRefs: sourceDraft?.evidence_refs || [], version: APPLICATION_ACTIVATION_VERSION,
      generatedAt: this.clock().toISOString(), recipient: primaryContact?.publicEmail || '',
      publicUrl: publicTarget(primaryContact, channel), contactName: primaryContact?.name || '',
      contactTitle: primaryContact?.title || '', contactType: primaryContact?.contactType || '',
      contactConfidence: primaryContact?.confidence || '', company: clean(job.company || companyResearch.name),
      packageId: packageRecord?.id || null, packageVersion: packageRecord?.packageVersion ?? null,
      applicationUrl:clean(applicationPath.url),applicationChannel:upper(applicationPath.primaryPath)||'UNKNOWN',
    };
    const outreachPlan = { ...draftCore, hash: hashStable(JSON.stringify(draftCore)) };
    const activationCore = {
      version: APPLICATION_ACTIVATION_VERSION, jobId: clean(job.id || job.jobId),
      status: applicationStrategy.status === 'APPLICATION_READY' && ['COMPLETE_WITH_CONTACT', 'COMPLETE_NONE_VERIFIED', 'BLOCKED'].includes(upper(contactIntelligence?.completionStatus)) ? 'ACTIVATION_READY' : 'ACTIVATION_BLOCKED',
      applicationStrategy, outreachStrategy, timing, primaryContact, secondaryContact,
      recommendedChannels: outreachRelevant ? [channel] : [],
      reasoning: outreachStrategy === 'OUTREACH_RECOMMENDED'
        ? `${primaryContact.contactType} is supported by public evidence and is relevant to hiring.`
        : outreachStrategy === 'OUTREACH_OPTIONAL' ? 'A bounded public route exists, but direct role ownership is not proven.'
          : outreachStrategy === 'OUTREACH_BLOCKED' ? 'Contact research could not reach a terminal safe result.'
            : 'No sufficiently relevant verified public outreach route was found.',
      evidence: { contactSource: primaryContact?.source || null, sourceProvenance, evaluationId: evaluation?.id || null },
      humanActionsRequired: authorizationRelevant ? ['REVIEW_APPLICATION', 'DECIDE_APPLICATION', 'DECIDE_OUTREACH'] : outreachStrategy==='MANUAL_OUTREACH_RECOMMENDED'?['REVIEW_APPLICATION','DECIDE_APPLICATION','MANUAL_OUTREACH']:['REVIEW_APPLICATION', 'DECIDE_APPLICATION'],
      authorizationScope: { application: 'APPROVE_TO_APPLY', outreach: authorizationRelevant ? 'APPROVE_OUTREACH' : 'NOT_REQUIRED', implicitCoupling: false },
      execution: {
        emailCapability: Boolean(channelCapabilities.emailOutreachConfigured),
        linkedinCapability: Boolean(channelCapabilities.linkedinExactMessaging),
        automaticOutreach: Boolean(channelCapabilities.emailOutreachConfigured || channelCapabilities.linkedinExactMessaging),
      },
      recommendedFollowUp: { eligibleAfter: 'APPLICATION_CONFIRMED', afterBusinessDays: 5, automaticSend: false },
      outreachPlan, candidatePreferencesUsed: Boolean(Object.keys(candidatePreferences || {}).length),
      companyResearchUsed: Boolean(Object.keys(companyResearch || {}).length), hiringResearchUsed: Boolean(Object.keys(hiringResearch || {}).length),
    };
    return { ...activationCore, generatedAt: this.clock().toISOString(), hash: hashStable(JSON.stringify(activationCore)) };
  }
}

export function buildApplicationActivationPlan(input, options) {
  return new ApplicationActivationPlanner(options).plan(input);
}
