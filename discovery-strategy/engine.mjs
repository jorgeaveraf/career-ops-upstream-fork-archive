import { hashStable } from '../acquisition/normalize.mjs';
import { DEFAULT_HARD_REJECT_COMPANIES, DEFAULT_POOL_PHRASES } from '../intelligence/unified-candidate-policy.mjs';

export const DISCOVERY_STRATEGY_VERSION = '1';

const array = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? '').trim();
const unique = values => [...new Set(values.map(text).filter(Boolean))];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('discovery_strategy must be an object');
  if (config.enabled === false) return;
  if (!config.platforms || typeof config.platforms !== 'object' || Array.isArray(config.platforms)) throw new TypeError('discovery_strategy.platforms must be an object');
  for (const [source, runbook] of Object.entries(config.platforms)) {
    if (!runbook || typeof runbook !== 'object' || Array.isArray(runbook)) throw new TypeError(`discovery_strategy.platforms.${source} must be an object`);
    if (!Array.isArray(runbook.phases) || !runbook.phases.length) throw new TypeError(`discovery_strategy.platforms.${source}.phases must be a non-empty array`);
    for (const phase of runbook.phases) {
      if (!text(phase?.id) || !text(phase?.mode) || !text(phase?.objective)) throw new TypeError(`${source} runbook phases require id, mode, and objective`);
    }
  }
}

export function createDiscoveryStrategy({ candidateProvider, config } = {}) {
  if (!candidateProvider) throw new TypeError('candidateProvider is required');
  const preferences = candidateProvider.getPreferences();
  const configured = config || preferences.discovery_strategy;
  validateConfig(configured);
  const identity = candidateProvider.getIdentity();
  const metadata = candidateProvider.getMetadata();
  const primaryRoles = unique(preferences.primary_roles || [identity.primary_title]);
  const secondaryRoles = unique([
    ...array(preferences.alternative_roles), ...array(configured.role_variants),
  ]).filter(role => !primaryRoles.includes(role));
  const confirmedTechnologies = unique(candidateProvider.getSkills().map(skill => skill.name));
  const technologies = unique([
    ...(configured.technology_terms?.include_candidate_kb === false ? [] : confirmedTechnologies),
    ...array(configured.technology_terms?.additional),
  ]);
  const strategy = {
    version: String(configured.version || DISCOVERY_STRATEGY_VERSION),
    enabled: configured.enabled !== false,
    candidateKbRevision: metadata.revision,
    roles: { primary: primaryRoles, secondary: secondaryRoles },
    technologies,
    technologyProvenance: {
      candidateKb: confirmedTechnologies,
      explicitSearchTerms: unique(array(configured.technology_terms?.additional)),
    },
    domains: unique(identity.domains || []),
    preferences: {
      remoteOnly: array(preferences.work_location?.accepted).some(value => /remote/i.test(value))
        && array(preferences.work_location?.excluded).some(value => /hybrid|on[ -]?site/i.test(value)),
      contractorPreferred: array(preferences.employment_types).sort((a, b) => Number(a.preference) - Number(b.preference))[0]?.type === 'Contract',
      regions: array(preferences.geographic_markets).map(item => item.market).filter(Boolean),
      seniority: preferences.seniority || {},
    },
    rejectionRules: {
      ...structuredClone(configured.rejection_rules || {}),
      companies: unique([...DEFAULT_HARD_REJECT_COMPANIES, ...array(configured.rejection_rules?.companies)]),
      pool_signals: {
        ...structuredClone(configured.rejection_rules?.pool_signals || {}),
        phrases: unique([...DEFAULT_POOL_PHRASES, ...array(configured.rejection_rules?.pool_signals?.phrases)]),
      },
    },
    compensationPolicy: structuredClone(configured.compensation_policy || {}),
    sourcePriorities: structuredClone(configured.source_priorities || {}),
    platforms: structuredClone(configured.platforms || {}),
  };
  return Object.freeze({ ...strategy, revision: `${strategy.version}:${hashStable(JSON.stringify(stable(strategy))).slice(0, 12)}` });
}
