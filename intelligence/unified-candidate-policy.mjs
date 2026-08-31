import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { hashStable } from '../acquisition/normalize.mjs';
import { boundedInteger } from '../candidate-selection/contracts.mjs';

export const UNIFIED_CANDIDATE_POLICY_VERSION = '1.1';
export const EVIDENCE_COMPLETENESS_VERSION = '1';
export const RESEARCH_NEEDS_VERSION = '1';

export const DEFAULT_HARD_REJECT_COMPANIES = Object.freeze(['micro1', 'bairesdev']);
export const DEFAULT_POOL_PHRASES = Object.freeze([
  'join our talent network', 'join our talent pool', 'developer pool', 'talent marketplace',
  'we match you with clients', 'we will match you with opportunities', 'future opportunities',
  'join our developer network', 'multiple opportunities available',
]);

export function normalizeCompanyPolicyIdentity(value) {
  const tokens = String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length > 1 && tokens.at(-1) === 'io') tokens.pop();
  return tokens.join(' ');
}

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';
const unique = values => [...new Set(values.map(text).filter(Boolean))];
const employmentKey = value => text(value).toLowerCase().replace(/[\s-]+/g, '_');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function configuredStrategicSignals(workPreferences = {}) {
  const positivePolicy = text(workPreferences.excites).toLowerCase();
  const negativePolicy = text(workPreferences.avoids).toLowerCase();
  const concepts = [
    { policy: /arquitectura|architecture/, posting: ['architecture', 'architect'] },
    { policy: /extremo a extremo|end[ -]to[ -]end|ownership/, posting: ['end-to-end', 'end to end', 'ownership'] },
    { policy: /autonom/, posting: ['autonomy', 'autonomous'] },
    { policy: /plataformas? de datos|data platforms?/, posting: ['data platform'] },
    { policy: /soluciones de ia|sistemas de ia|ai systems?/, posting: ['ai systems'] },
    { policy: /orientad[ao]s? a eventos|event-driven/, posting: ['event-driven'] },
    { policy: /producci[oó]n|production/, posting: ['production'] },
  ];
  const negativeConcepts = [
    { policy: /micromanagement/, posting: ['micromanagement'] },
    { policy: /repetitiv/, posting: ['repetitive tasks', 'ticket factory'] },
    { policy: /intermitent|intermittent/, posting: ['intermittent workload'] },
  ];
  return {
    positive: concepts.filter(item => item.policy.test(positivePolicy)).flatMap(item => item.posting),
    negative: negativeConcepts.filter(item => item.policy.test(negativePolicy)).flatMap(item => item.posting),
  };
}

export function createUnifiedCandidatePolicy(profile = {}, portals = {}, overrides = {}) {
  const work = profile?.search_preferences || {};
  const seniority = profile?.target_roles?.seniority || {};
  const strategy = profile?.discovery_strategy || {};
  const rejection = strategy?.rejection_rules || {};
  const acceptedLocations = list(work?.work_location?.accepted);
  const excludedLocations = list(work?.work_location?.excluded);
  const employment = list(work.employment_types).map(item => ({
    type: text(item?.type), key: employmentKey(item?.type),
    preference: Number.isFinite(Number(item?.preference)) ? Number(item.preference) : 99,
    minimumCommitment: text(item?.minimum_commitment), condition: text(item?.condition),
  })).filter(item => item.key);
  const compensation = Object.fromEntries(Object.entries(profile?.compensation?.by_employment_type || {})
    .map(([key, value]) => [employmentKey(key), {
      minimum: Number.isFinite(Number(value?.minimum)) ? Number(value.minimum) : null,
      desired: Number.isFinite(Number(value?.desired)) ? Number(value.desired) : null,
      currency: text(value?.currency).toUpperCase(), period: employmentKey(value?.period), basis: text(value?.basis).toLowerCase(),
    }]));
  const configuredMarketComp = strategy?.compensation_policy || {};
  const marketCompensation = {
    mexican: {
      minimum: Number(configuredMarketComp?.mexico?.minimum) || 50_000,
      currency: text(configuredMarketComp?.mexico?.currency).toUpperCase() || 'MXN',
      period: employmentKey(configuredMarketComp?.mexico?.period) || 'month',
      basis: text(configuredMarketComp?.mexico?.basis).toLowerCase() || 'net',
    },
    foreign: {
      minimum: Number(configuredMarketComp?.foreign?.minimum) || 40_000,
      currency: text(configuredMarketComp?.foreign?.currency).toUpperCase() || 'MXN',
      period: employmentKey(configuredMarketComp?.foreign?.period) || 'month',
      basis: text(configuredMarketComp?.foreign?.basis).toLowerCase() || 'net',
    },
    belowThresholdAction: text(configuredMarketComp?.below_threshold_action).toLowerCase() || 'reject',
    preserveUnknown: configuredMarketComp?.preserve_unknown !== false,
  };
  const rolePhrases = unique([
    ...list(profile?.target_roles?.primary), ...list(profile?.target_roles?.alternatives),
    ...list(profile?.target_roles?.archetypes).map(item => item?.name), ...list(strategy?.role_variants),
    ...list(portals?.title_filter?.positive),
  ]);
  const relevant = {
    unifiedPolicyVersion: UNIFIED_CANDIDATE_POLICY_VERSION,
    evidenceCompletenessVersion: EVIDENCE_COMPLETENESS_VERSION,
    researchNeedsVersion: RESEARCH_NEEDS_VERSION,
    rulesVersion: String(overrides.rulesVersion || '2'),
    maxActiveCandidates: boundedInteger(overrides.maxActiveCandidates, 1, 1000, 100),
    minimumSelectionScore: boundedInteger(overrides.minimumSelectionScore, 0, 100, 58),
    freshnessWindowDays: boundedInteger(overrides.freshnessWindowDays ?? portals?.max_posting_age_days, 1, 365, 21),
    fillToCapacity: false,
    topLimit: boundedInteger(overrides.topLimit, 1, 10, 10),
    topMinimumPriorityScore: boundedInteger(overrides.topMinimumPriorityScore, 0, 100, 80),
    sourceDiversity: {
      enabled: overrides.sourceDiversity?.enabled !== false,
      maximumShare: Number.isFinite(Number(overrides.sourceDiversity?.maximumShare))
        ? Math.max(0.1, Math.min(1, Number(overrides.sourceDiversity.maximumShare))) : 0.5,
    },
    candidateCountry: text(profile?.location?.country),
    authorizedIn: unique(list(profile?.location?.authorized_in)),
    needsSponsorship: profile?.location?.needs_sponsorship === true,
    internationalContractingAccepted: profile?.location?.international_contracting?.accepted === true,
    remoteOnly: acceptedLocations.some(item => /remote/i.test(item))
      && excludedLocations.some(item => /(?:hybrid|on[ -]?site)/i.test(item)),
    rolePhrases,
    titleExclusions: unique([...list(seniority?.excluded), ...list(portals?.title_filter?.negative)]),
    excludedSeniority: unique([...list(seniority?.excluded), ...list(portals?.title_filter?.negative)]).map(item => item.toLowerCase()),
    acceptedSeniority: unique([
      ...list(seniority?.preferred), ...list(seniority?.also_accepted).map(item => item?.level),
      ...list(portals?.title_filter?.seniority_boost),
    ]),
    seniorityBoosts: unique([
      ...list(seniority?.preferred), ...list(seniority?.also_accepted).map(item => item?.level),
      ...list(portals?.title_filter?.seniority_boost),
    ]),
    hardRejectCompanies: unique([...DEFAULT_HARD_REJECT_COMPANIES, ...list(rejection?.companies)]),
    poolSignals: {
      action: text(rejection?.pool_signals?.action).toLowerCase() || 'penalize',
      penalty: boundedInteger(rejection?.pool_signals?.priority_penalty, 0, 100, 25),
      phrases: unique([...DEFAULT_POOL_PHRASES, ...list(rejection?.pool_signals?.phrases)]),
    },
    location: {
      alwaysAllow: unique(list(portals?.location_filter?.always_allow)),
      allow: unique(list(portals?.location_filter?.allow)),
      block: unique(list(portals?.location_filter?.block)), excluded: unique(excludedLocations),
    },
    countryEligibility: {
      exclusionary: unique(list(portals?.country_eligibility_filter?.exclusionary)),
      inclusive: unique(list(portals?.country_eligibility_filter?.inclusive)),
    },
    geographicSignals: {
      mexicoAliases: ['mexico', 'mexico city', 'ciudad de mexico', 'cdmx'],
      inclusive: unique([
        'latin america', 'latam', 'worldwide', 'anywhere', 'global remote', 'work from anywhere',
        'remote from mexico', 'international contractor', 'hire in mexico', 'mexico contractor',
        'employer of record mexico', 'open to candidates globally', 'contractors worldwide',
        ...list(portals?.country_eligibility_filter?.inclusive),
      ]),
      exclusionary: unique([
        'us only', 'united states only', 'must reside in united states', 'must reside in the united states',
        'us residents only', 'canada only', 'eu only', 'uk only', 'must reside in california',
        ...list(portals?.country_eligibility_filter?.exclusionary),
      ]),
    },
    contentExclusions: unique(list(portals?.content_filter?.negative)),
    employment, compensation, marketCompensation,
    schedule: {
      positive: ['async', 'asynchronous', 'flexible hours', 'flexible schedule', 'distributed', 'timezone overlap', 'latam hours'],
      negative: ['night shift', 'overnight shift', 'mandatory pst full day', 'us business hours required', 'us business hours only', '24/7 on-call', 'frequent on-call'],
    },
    workPreferences: {
      excites: text(work?.work_preferences?.excites), avoids: text(work?.work_preferences?.avoids),
      engagementDuration: text(work?.engagement_preferences?.duration),
      engagementWorkload: text(work?.engagement_preferences?.workload),
      strategicSignals: configuredStrategicSignals(work?.work_preferences),
    },
  };
  const policyHash = hashStable(JSON.stringify(stable(relevant)));
  return Object.freeze({ ...relevant, policyHash, profileHash: policyHash });
}

export function loadUnifiedCandidatePolicy({
  profilePath = process.env.CAREER_OPS_PROFILE || 'config/profile.yml',
  portalsPath = process.env.CAREER_OPS_PORTALS || 'portals.yml', overrides = {},
} = {}) {
  return createUnifiedCandidatePolicy(
    yaml.load(readFileSync(profilePath, 'utf8')) || {},
    yaml.load(readFileSync(portalsPath, 'utf8')) || {}, overrides,
  );
}
