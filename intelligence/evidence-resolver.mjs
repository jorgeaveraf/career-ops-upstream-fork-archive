import { hashStable } from '../acquisition/normalize.mjs';
import { EVIDENCE_COMPLETENESS_VERSION, RESEARCH_NEEDS_VERSION } from './unified-candidate-policy.mjs';

const PLACEHOLDERS = new Set(['', 'unknown', 'n a', 'na', 'none', 'null', 'undefined', 'not available', 'not provided']);
const RESEARCH_IMPACT = Object.freeze({
  RESOLVE_LOCATION_CONFLICT: 100,
  CONFIRM_MEXICO_ELIGIBILITY: 95,
  CONFIRM_REMOTE_SCOPE: 90,
  CONFIRM_POSTING_IS_REAL: 88,
  FETCH_FULL_DESCRIPTION: 85,
  CONFIRM_EMPLOYMENT_MODEL: 55,
  CONFIRM_COMPENSATION: 40,
  CONFIRM_COMPANY_MARKET: 35,
  CONFIRM_SCHEDULE: 25,
});

export function normalizeEvidenceText(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function meaningfulEvidenceText(value) {
  const normalized = normalizeEvidenceText(value);
  return PLACEHOLDERS.has(normalized) ? '' : normalized;
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function array(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function fieldEvidence(job, names) {
  const accepted = new Set(names.map(normalizeEvidenceText));
  return array(job?.fieldEvidence).filter(item => accepted.has(normalizeEvidenceText(item?.field)));
}
function phrase(haystack, values) {
  return array(values).find(value => {
    const needle = normalizeEvidenceText(value);
    if (!needle) return false;
    return needle.length <= 3 ? new RegExp(`\\b${needle}\\b`).test(haystack) : haystack.includes(needle);
  }) || '';
}
function entry(dimension, field, signal, value, confidence = 'high', source = 'job_observation', effect = 'neutral') {
  return { ruleId: `${dimension}.${signal}`, dimension, field, signal, value, confidence, source, effect };
}

function metadataTexts(metadata) {
  const eligible = [metadata.remoteScope, metadata.remote_scope, metadata.eligibility, metadata.locationEligibility,
    metadata.companyHiringPolicy, metadata.company_hiring_policy,
    ...array(metadata.eligibleCountries), ...array(metadata.eligible_countries), ...array(metadata.countries)];
  return meaningfulEvidenceText(eligible.join(' '));
}

export function resolveGeography(job, policy) {
  const title = meaningfulEvidenceText(job?.title);
  const location = meaningfulEvidenceText(job?.location);
  const description = meaningfulEvidenceText(job?.description);
  const metadata = object(job?.rawMetadata);
  const structured = meaningfulEvidenceText([metadataTexts(metadata), job?.eligibility, job?.remoteScope,
    ...array(job?.eligibleCountries)].join(' '));
  const fields = [
    ['title', title, 'job_title'], ['location', location, 'job_location'],
    ['description', description, 'job_description'], ['rawMetadata', structured, 'provider_metadata'],
    ...fieldEvidence(job, ['eligibility', 'remoteScope', 'eligibleCountries', 'location', 'title', 'companyHiringPolicy'])
      .map(item => [`fieldEvidence.${item.field}`, meaningfulEvidenceText(array(item.value).join(' ')),
        `field_evidence:${item.provider || 'unknown'}`, item.confidence || 'medium']),
  ];
  const positivePhrases = [...array(policy?.geographicSignals?.mexicoAliases), ...array(policy?.geographicSignals?.inclusive)];
  const negativePhrases = array(policy?.geographicSignals?.exclusionary);
  const positive = [];
  const negative = [];
  const remote = [];
  for (const [field, text, source, evidenceConfidence] of fields) {
    if (!text) continue;
    const positiveHit = phrase(text.replace(/\bnew mexico\b/g, ''), positivePhrases);
    const residencyMatch = text.match(/\bmust (?:reside|be located|be based) in (?!mexico\b)(?:the )?([a-z ]{2,40}?)(?:\.|,|$)/)?.[0] || '';
    const negativeHit = phrase(text, negativePhrases) || residencyMatch;
    const remoteHit = phrase(text, ['remote', 'distributed', 'work from home', 'desde casa']);
    if (positiveHit) {
      const normalizedHit = normalizeEvidenceText(positiveHit);
      const isMexico = array(policy?.geographicSignals?.mexicoAliases).some(value => normalizeEvidenceText(value) === normalizedHit);
      const signal = field === 'title' && isMexico && /\bonly mexico\b/.test(text) ? 'mexico_only'
        : isMexico ? 'mexico_scope' : 'supported_international_scope';
      positive.push(entry('geography', field, signal, positiveHit, evidenceConfidence || (field === 'description' ? 'medium' : 'high'), source, 'positive'));
    }
    if (negativeHit) negative.push(entry('geography', field, 'foreign_residency_lock', negativeHit, evidenceConfidence || 'high', source, 'negative'));
    if (remoteHit) remote.push(entry('geography', field, 'remote', remoteHit, evidenceConfidence || 'medium', source));
  }
  let status = 'UNKNOWN';
  if (positive.length && negative.length) status = 'CONFLICTING';
  else if (negative.length) status = 'EXCLUDED';
  else if (positive.length) status = 'SUPPORTED';
  else if (remote.length) status = 'AMBIGUOUS';
  return { status, positive, negative, remote, evidence: [...positive, ...negative, ...remote], confidence: status === 'SUPPORTED' || status === 'EXCLUDED' ? 'high' : status === 'CONFLICTING' ? 'medium' : 'low' };
}

export function resolveEmployment(job) {
  const metadata = object(job?.rawMetadata);
  const employmentEvidence = fieldEvidence(job, ['employmentType', 'employmentModel', 'contractType']);
  const structured = meaningfulEvidenceText([job?.employmentType, metadata.employmentType, metadata.employment_type, metadata.contractType,
    ...employmentEvidence.map(item => item.value)].join(' '));
  const content = meaningfulEvidenceText([job?.title, job?.description].join(' '));
  const rules = [
    ['fractional', /\bfractional\b/],
    ['part_time', /\bpart time\b|\b20\s*(?:hours|hrs)\b/],
    ['contract', /\bcontract(?:or|ing)?\b|\bfreelanc(?:e|er)\b|\bindependent (?:consultant|contractor)\b/],
    ['temporary', /\btemporary\b|\btemp role\b|\bfixed term\b/],
    ['full_time', /\bfull time\b|\bpermanent employee\b/],
  ];
  for (const [model, pattern] of rules) {
    const structuredMatch = structured.match(pattern);
    if (structuredMatch) return { model, confidence: 'high', evidence: [entry('employment', 'employmentType', model, structuredMatch[0], 'high', 'structured_field')] };
  }
  for (const [model, pattern] of rules) {
    const match = content.match(pattern);
    if (match) return { model, confidence: 'medium', evidence: [entry('employment', 'title/description', model, match[0], 'medium', 'job_posting')] };
  }
  return { model: 'unknown', confidence: 'low', evidence: [] };
}

export function resolveSchedule(job, policy) {
  const metadata = object(job?.rawMetadata);
  const content = meaningfulEvidenceText([job?.description, metadata.schedule, metadata.workingHours, metadata.timezone,
    ...fieldEvidence(job, ['schedule', 'workingHours', 'timezone']).map(item => item.value)].join(' '));
  const negative = phrase(content, policy?.schedule?.negative);
  if (negative) return { status: 'CONFLICTING', confidence: 'high', evidence: [entry('schedule', 'description/rawMetadata', 'hard_schedule_conflict', negative, 'high', 'job_posting', 'negative')] };
  const positive = phrase(content, policy?.schedule?.positive);
  if (positive) return { status: 'SUPPORTED', confidence: 'medium', evidence: [entry('schedule', 'description/rawMetadata', 'compatible_schedule', positive, 'medium', 'job_posting', 'positive')] };
  return { status: 'UNKNOWN', confidence: 'low', evidence: [] };
}

export function resolveCompanyMarket(job) {
  const metadata = object(job?.rawMetadata);
  const raw = meaningfulEvidenceText([metadata.companyMarket, metadata.company_market, object(metadata.company).market, job?.companyMarket,
    ...fieldEvidence(job, ['companyMarket', 'company_market']).map(item => item.value)].join(' '));
  const mexican = phrase(raw, ['mexican', 'mexico', 'domestic']);
  const foreign = phrase(raw, ['foreign', 'international', 'non mexican']);
  if (mexican && foreign) return { status: 'UNKNOWN', confidence: 'low', evidence: [entry('company_market', 'rawMetadata', 'conflicting_market', raw, 'low', 'structured_field')] };
  if (mexican) return { status: 'MEXICAN', confidence: 'high', evidence: [entry('company_market', 'rawMetadata', 'mexican_market', raw, 'high', 'structured_field', 'positive')] };
  if (foreign) return { status: 'FOREIGN', confidence: 'high', evidence: [entry('company_market', 'rawMetadata', 'foreign_market', raw, 'high', 'structured_field')] };
  return { status: 'UNKNOWN', confidence: 'low', evidence: [] };
}

function period(value) {
  const text = normalizeEvidenceText(value);
  if (/hour/.test(text)) return 'hour';
  if (/month/.test(text)) return 'month';
  if (/year|annual/.test(text)) return 'year';
  return '';
}

function structuredCompensation(job) {
  const evidenced = fieldEvidence(job, ['salary', 'compensation']).map(item => item.value).find(value => object(value) === value);
  const raw = object(job?.salary || job?.compensation || object(job?.rawMetadata).salary || evidenced);
  const min = Number(raw.min ?? raw.minimum ?? raw.amount);
  const max = Number(raw.max ?? raw.maximum ?? raw.amount);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null;
  return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null,
    currency: String(raw.currency || '').trim().toUpperCase(), period: period(raw.period || raw.interval),
    basis: normalizeEvidenceText(raw.basis), source: 'structured_compensation' };
}

function describedCompensation(job) {
  const content = meaningfulEvidenceText(job?.description);
  const match = content.match(/\b(usd|mxn|eur)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:-|to|a)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:per|por|\/)?\s*(hour|hr|month|year|annual)\b/);
  if (!match) return null;
  return { min: Number(match[2]), max: Number(match[3]), currency: match[1].toUpperCase(),
    period: period(match[4]), basis: '', source: 'description_parse' };
}

export function resolveCompensation(job, policy, companyMarket) {
  const value = structuredCompensation(job) || describedCompensation(job);
  if (!value) return { status: 'UNKNOWN', comparison: 'not_available', value: null, target: null, confidence: 'low', evidence: [] };
  const marketKey = companyMarket?.status === 'MEXICAN' ? 'mexican' : companyMarket?.status === 'FOREIGN' ? 'foreign' : '';
  const target = marketKey ? policy?.marketCompensation?.[marketKey] : null;
  const evidence = [entry('compensation', value.source === 'structured_compensation' ? 'salary/compensation' : 'description', value.source, value, value.source === 'structured_compensation' ? 'high' : 'medium', value.source === 'structured_compensation' ? 'structured_field' : 'job_posting')];
  if (!target || !value.currency || !value.period || !value.basis
      || value.currency !== target.currency || value.period !== target.period || value.basis !== target.basis) {
    return { status: 'NOT_COMPARABLE', comparison: 'not_comparable_without_inference', value, target: target || null, confidence: 'medium', evidence };
  }
  const upper = value.max ?? value.min;
  if (upper < target.minimum) return { status: 'BELOW_THRESHOLD', comparison: 'below_threshold', value, target, confidence: 'high', evidence };
  return { status: 'KNOWN_ACCEPTABLE', comparison: 'meets_threshold', value, target, confidence: 'high', evidence };
}

export function resolvePostingNature(job, policy) {
  const metadata = object(job?.rawMetadata);
  const title = meaningfulEvidenceText(job?.title);
  const content = meaningfulEvidenceText([job?.title, job?.description].join(' '));
  const signal = phrase(content, policy?.poolSignals?.phrases);
  if (!signal) return { status: 'REAL_OR_UNSPECIFIED', poolSignal: '', penalty: 0, evidence: [] };
  const explicitlyPool = metadata.poolOnly === true || metadata.pool_only === true;
  const genericTitle = phrase(title, ['talent pool', 'talent network', 'developer network', 'future opportunities']);
  const roleAnchor = /\b(engineer|engineering|architect|developer|manager|scientist)\b/.test(title);
  const poolOnly = explicitlyPool || Boolean(genericTitle) || !roleAnchor;
  return { status: poolOnly ? 'CONFIRMED_POOL_ONLY' : 'MARKETPLACE_SIGNAL', poolSignal: signal,
    penalty: poolOnly ? 0 : Number(policy?.poolSignals?.penalty || 0),
    evidence: [entry('posting', explicitlyPool ? 'rawMetadata' : 'title/description', poolOnly ? 'pool_only' : 'marketplace_warning', signal, explicitlyPool || genericTitle ? 'high' : 'medium', 'job_posting', poolOnly ? 'negative' : 'neutral')] };
}

function completenessDimension(status, confidence, evidence = []) { return { status, confidence, evidence }; }

export function resolveCandidateEvidence(job, policy) {
  const geography = resolveGeography(job, policy);
  const employment = resolveEmployment(job);
  const schedule = resolveSchedule(job, policy);
  const companyMarket = resolveCompanyMarket(job);
  const compensation = resolveCompensation(job, policy, companyMarket);
  const posting = resolvePostingNature(job, policy);
  const description = meaningfulEvidenceText(job?.description);
  const completeness = {
    version: EVIDENCE_COMPLETENESS_VERSION,
    description: completenessDimension(description ? 'PRESENT' : 'MISSING', description ? 'high' : 'low', []),
    geography: completenessDimension(geography.status, geography.confidence, geography.evidence),
    employment: completenessDimension(employment.model === 'unknown' ? 'MISSING' : 'PRESENT', employment.confidence, employment.evidence),
    compensation: completenessDimension(compensation.status, compensation.confidence, compensation.evidence),
    schedule: completenessDimension(schedule.status, schedule.confidence, schedule.evidence),
    companyMarket: completenessDimension(companyMarket.status, companyMarket.confidence, companyMarket.evidence),
    posting: completenessDimension(posting.status, posting.status === 'REAL_OR_UNSPECIFIED' ? 'medium' : posting.evidence[0]?.confidence || 'low', posting.evidence),
  };
  completeness.evidenceWeak = completeness.description.status === 'MISSING' || !['SUPPORTED', 'EXCLUDED'].includes(completeness.geography.status);
  return { geography, employment, schedule, companyMarket, compensation, posting, evidenceCompleteness: completeness };
}

function needPriority(type, selectionScore = 0, rank = null) {
  const numeric = RESEARCH_IMPACT[type] + Math.round(Math.max(0, Math.min(100, Number(selectionScore) || 0)) / 10)
    + (Number.isFinite(Number(rank)) ? Math.max(0, 6 - Math.min(6, Number(rank))) : 0);
  return { score: numeric, band: numeric >= 90 ? 'HIGH' : numeric >= 65 ? 'MEDIUM' : 'LOW' };
}

export function buildResearchNeeds(job, resolved, { selectionScore = job?.selectionScore, rank = job?.selectionRank } = {}) {
  const needs = [];
  const add = (type, dimension, reason) => {
    const priority = needPriority(type, selectionScore, rank);
    needs.push({ type, dimension, reason, priority: priority.band, priorityScore: priority.score, status: 'OPEN',
      researchNeedsVersion: RESEARCH_NEEDS_VERSION,
      needKey: hashStable(JSON.stringify({ jobId: job?.jobId || '', observationId: job?.observationId || '', type, version: RESEARCH_NEEDS_VERSION })) });
  };
  if (resolved.evidenceCompleteness.description.status === 'MISSING') add('FETCH_FULL_DESCRIPTION', 'description', 'Full job description is missing.');
  if (resolved.geography.status === 'CONFLICTING') add('RESOLVE_LOCATION_CONFLICT', 'geography', 'Positive Mexico scope and a foreign residency lock conflict.');
  else if (['UNKNOWN', 'AMBIGUOUS'].includes(resolved.geography.status)) {
    add('CONFIRM_MEXICO_ELIGIBILITY', 'geography', 'No evidence confirms that a Mexico-based candidate is eligible.');
    if (resolved.geography.status === 'AMBIGUOUS') add('CONFIRM_REMOTE_SCOPE', 'geography', 'Remote is stated without a country scope.');
  }
  if (resolved.employment.model === 'unknown') add('CONFIRM_EMPLOYMENT_MODEL', 'employment', 'Employment model is not stated.');
  if (['UNKNOWN', 'NOT_COMPARABLE'].includes(resolved.compensation.status)) add('CONFIRM_COMPENSATION', 'compensation', resolved.compensation.status === 'UNKNOWN' ? 'Compensation is missing.' : 'Compensation cannot be compared without guessing.');
  if (resolved.companyMarket.status === 'UNKNOWN') add('CONFIRM_COMPANY_MARKET', 'company_market', 'Company market is not evidenced.');
  if (resolved.schedule.status === 'UNKNOWN') add('CONFIRM_SCHEDULE', 'schedule', 'Schedule compatibility is not evidenced.');
  if (resolved.posting.status === 'MARKETPLACE_SIGNAL') add('CONFIRM_POSTING_IS_REAL', 'posting', 'A marketplace signal exists; confirm this is a concrete opening.');
  return needs.sort((a, b) => b.priorityScore - a.priorityScore || a.type.localeCompare(b.type));
}
