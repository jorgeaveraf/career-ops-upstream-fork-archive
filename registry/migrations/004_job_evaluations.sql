CREATE TABLE job_evaluations (
  id TEXT PRIMARY KEY,
  evaluation_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES job_assessments(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('VALID', 'REJECTED')),
  recommendation TEXT CHECK (recommendation IS NULL OR recommendation IN ('APPLY', 'CONSIDER', 'DO_NOT_APPLY')),
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  overall_fit INTEGER CHECK (overall_fit IS NULL OR overall_fit BETWEEN 0 AND 100),
  candidate_kb_version INTEGER NOT NULL,
  candidate_kb_hash TEXT NOT NULL,
  candidate_kb_revision TEXT NOT NULL,
  evaluation_engine_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  job_analysis_hash TEXT NOT NULL,
  job_analysis_json TEXT NOT NULL,
  evidence_matches_json TEXT NOT NULL,
  structured_output_json TEXT,
  rejected_output_json TEXT,
  validation_json TEXT NOT NULL,
  usage_json TEXT,
  evaluated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_job_evaluations_job_time ON job_evaluations(job_id, evaluated_at DESC);
CREATE INDEX idx_job_evaluations_assessment ON job_evaluations(assessment_id);
CREATE INDEX idx_job_evaluations_identity ON job_evaluations(
  job_id, candidate_kb_hash, prompt_version, provider_id, model_id, job_analysis_hash
);

