CREATE TABLE job_assessments (
  id TEXT PRIMARY KEY,
  assessment_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('ELIGIBLE', 'INELIGIBLE', 'UNKNOWN')),
  eligibility_score INTEGER NOT NULL CHECK (eligibility_score BETWEEN 0 AND 100),
  candidate_fit_score INTEGER NOT NULL CHECK (candidate_fit_score BETWEEN 0 AND 100),
  opportunity_score INTEGER NOT NULL CHECK (opportunity_score BETWEEN 0 AND 100),
  final_priority_score INTEGER NOT NULL CHECK (final_priority_score BETWEEN 0 AND 100),
  decision TEXT NOT NULL CHECK (decision IN ('SHORTLIST', 'CONSIDER', 'REVIEW', 'REJECT')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  eligibility_rules_version TEXT NOT NULL,
  ranking_rules_version TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  rules_applied_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_assessments_job_time ON job_assessments(job_id, assessed_at DESC);
CREATE INDEX idx_assessments_observation_versions ON job_assessments(
  observation_id, eligibility_rules_version, ranking_rules_version, profile_hash
);
CREATE INDEX idx_assessments_priority ON job_assessments(decision, final_priority_score DESC);
