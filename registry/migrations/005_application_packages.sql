CREATE TABLE application_packages (
  id TEXT PRIMARY KEY,
  package_key TEXT NOT NULL UNIQUE,
  package_version INTEGER NOT NULL CHECK (package_version > 0),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL REFERENCES job_evaluations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'REVIEW_REQUIRED', 'APPROVED', 'ARCHIVED')),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('VALID', 'REJECTED')),
  evaluation_key TEXT NOT NULL,
  evaluation_hash TEXT NOT NULL,
  candidate_kb_version INTEGER NOT NULL,
  candidate_kb_hash TEXT NOT NULL,
  candidate_kb_revision TEXT NOT NULL,
  cv_hash TEXT NOT NULL,
  cv_source TEXT NOT NULL,
  package_engine_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  artifacts_json TEXT,
  rejected_output_json TEXT,
  evidence_refs_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  usage_json TEXT,
  generated_at TEXT NOT NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, package_version)
);

CREATE INDEX idx_application_packages_job_version ON application_packages(job_id, package_version DESC);
CREATE INDEX idx_application_packages_evaluation ON application_packages(evaluation_id);
CREATE INDEX idx_application_packages_status ON application_packages(status, generated_at DESC);
CREATE INDEX idx_application_packages_identity ON application_packages(
  job_id, evaluation_hash, candidate_kb_hash, cv_hash, prompt_version, provider_id, model_id
);

