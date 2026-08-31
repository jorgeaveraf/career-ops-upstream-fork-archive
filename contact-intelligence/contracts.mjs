export const CONTACT_INTELLIGENCE_ARTIFACT_VERSION = 2;
export const CONTACT_INTELLIGENCE_ENGINE_VERSION = '2.0';

export const CONTACT_CONFIDENCE = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);
export const CONTACT_STATUSES = Object.freeze(['CONFIRMED', 'UNKNOWN']);
export const RELATIONSHIP_TYPES = Object.freeze([
  'RECRUITER', 'TALENT_ACQUISITION', 'HIRING_MANAGER', 'TEAM_LEAD',
  'FUNCTIONAL_LEADER', 'ENGINEERING_MANAGER', 'SOLUTIONS_LEADER', 'FOUNDER',
  'OTHER_RELEVANT', 'GENERAL_RECRUITING',
  // Legacy values remain readable for persisted V3 artifacts.
  'ENGINEERING_LEAD', 'TEAM_MEMBER', 'COMPANY_CONTACT', 'UNKNOWN',
]);
export const CONTACT_RESULT_STATUSES = Object.freeze(['PRIMARY_CONTACT','SECONDARY_CONTACT','GENERAL_RECRUITING','NONE_VERIFIED','BLOCKED']);
export const PUBLIC_SOURCE_TYPES = Object.freeze([
  'JOB_POSTING', 'COMPANY_PAGE', 'COMPANY_CAREERS_PAGE', 'PUBLIC_TEAM_PAGE',
  'PUBLIC_PROFILE', 'PUBLIC_DOCUMENT', 'MANUAL_PUBLIC_RESEARCH',
]);
export const STRATEGY_PATHS = Object.freeze([...RELATIONSHIP_TYPES.slice(0, -1), 'DIRECT_APPLICATION']);

/**
 * Future public-data integrations implement this boundary. Implementations
 * return observations only and never receive the registry or an action client.
 */
export class ContactDiscoveryProvider {
  constructor({ id, version = '1' } = {}) {
    if (!String(id || '').trim()) throw new TypeError('provider id is required');
    this.id = String(id).trim();
    this.version = String(version).trim() || '1';
  }

  async findCompany(_context) { throw new Error(`${this.id}.findCompany is not implemented`); }
  async findPeople(_context) { throw new Error(`${this.id}.findPeople is not implemented`); }
  async findRelationships(_context) { throw new Error(`${this.id}.findRelationships is not implemented`); }
}
