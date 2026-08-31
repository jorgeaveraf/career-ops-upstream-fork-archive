DROP INDEX IF EXISTS idx_contact_relationships_job;

ALTER TABLE contact_relationships RENAME TO contact_relationships_v3;

CREATE TABLE contact_relationships (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES contact_research(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN (
    'RECRUITER', 'TALENT_ACQUISITION', 'HIRING_MANAGER', 'TEAM_LEAD',
    'FUNCTIONAL_LEADER', 'ENGINEERING_MANAGER', 'SOLUTIONS_LEADER', 'FOUNDER',
    'OTHER_RELEVANT', 'GENERAL_RECRUITING',
    'ENGINEERING_LEAD', 'TEAM_MEMBER', 'COMPANY_CONTACT', 'UNKNOWN'
  )),
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'UNKNOWN')),
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  source_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(research_id, person_id)
);

INSERT INTO contact_relationships(
  id,research_id,job_id,company_id,person_id,relationship_type,status,
  confidence,source_hash,evidence_json,rationale,observed_at
)
SELECT id,research_id,job_id,company_id,person_id,relationship_type,status,
  confidence,source_hash,evidence_json,rationale,observed_at
FROM contact_relationships_v3;

DROP TABLE contact_relationships_v3;

CREATE INDEX idx_contact_relationships_job ON contact_relationships(job_id, relationship_type);
