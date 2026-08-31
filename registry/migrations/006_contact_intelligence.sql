CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  normalized_name TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL,
  domain TEXT UNIQUE,
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE company_evidence (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  field TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(company_id, evidence_id)
);

CREATE TABLE job_companies (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  evidence_json TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY(job_id, company_id)
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  normalized_name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  role TEXT,
  profile_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'UNKNOWN')),
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, normalized_name)
);

CREATE UNIQUE INDEX idx_people_company_profile_url ON people(company_id, profile_url) WHERE profile_url IS NOT NULL;

CREATE TABLE person_evidence (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  field TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(person_id, evidence_id)
);

CREATE TABLE contact_research (
  id TEXT PRIMARY KEY,
  research_key TEXT NOT NULL UNIQUE,
  contact_research_version INTEGER NOT NULL CHECK (contact_research_version > 0),
  company_research_version INTEGER NOT NULL CHECK (company_research_version > 0),
  artifact_version INTEGER NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  application_package_id TEXT REFERENCES application_packages(id) ON DELETE SET NULL,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status = 'CONTACT_INTELLIGENCE_READY'),
  review_status TEXT NOT NULL CHECK (review_status = 'HUMAN_REVIEW_REQUIRED'),
  source_hash TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  company_json TEXT NOT NULL,
  people_json TEXT NOT NULL,
  relationships_json TEXT NOT NULL,
  outreach_strategy_json TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  researched_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, contact_research_version),
  UNIQUE(company_id, company_research_version)
);

CREATE TABLE contact_research_people (
  research_id TEXT NOT NULL REFERENCES contact_research(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  person_ref TEXT NOT NULL,
  PRIMARY KEY(research_id, person_id)
);

CREATE TABLE contact_relationships (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES contact_research(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('RECRUITER', 'HIRING_MANAGER', 'ENGINEERING_LEAD', 'TEAM_MEMBER', 'COMPANY_CONTACT', 'UNKNOWN')),
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'UNKNOWN')),
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  source_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(research_id, person_id)
);

CREATE INDEX idx_contact_research_job_version ON contact_research(job_id, contact_research_version DESC);
CREATE INDEX idx_contact_research_company_version ON contact_research(company_id, company_research_version DESC);
CREATE INDEX idx_people_company ON people(company_id, normalized_name);
CREATE INDEX idx_contact_relationships_job ON contact_relationships(job_id, relationship_type);
