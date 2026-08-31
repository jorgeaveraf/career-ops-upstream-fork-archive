CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  observations_count INTEGER NOT NULL DEFAULT 0,
  new_jobs_count INTEGER NOT NULL DEFAULT 0,
  known_jobs_count INTEGER NOT NULL DEFAULT 0,
  changed_jobs_count INTEGER NOT NULL DEFAULT 0,
  duplicate_observations_count INTEGER NOT NULL DEFAULT 0,
  failures_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  canonical_title TEXT NOT NULL,
  canonical_company TEXT NOT NULL,
  canonical_url TEXT,
  location TEXT,
  normalized_title TEXT NOT NULL,
  normalized_company TEXT NOT NULL,
  normalized_location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DISCOVERED',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE job_observations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  first_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_version TEXT,
  external_id TEXT,
  source_url TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  description TEXT,
  content_hash TEXT,
  posted_at TEXT,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  extraction_method TEXT NOT NULL,
  confidence TEXT NOT NULL,
  observation_key TEXT NOT NULL UNIQUE,
  snapshot_hash TEXT NOT NULL,
  content_changed INTEGER NOT NULL DEFAULT 0 CHECK (content_changed IN (0, 1)),
  identity_method TEXT NOT NULL,
  identity_confidence TEXT NOT NULL,
  identity_evidence_json TEXT NOT NULL DEFAULT '{}',
  raw_metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE job_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  confidence TEXT NOT NULL,
  source_observation_id TEXT REFERENCES job_observations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(kind, namespace, value)
);

CREATE TABLE job_field_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL CHECK (length(field_name) > 0),
  value_json TEXT NOT NULL,
  confidence TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(observation_id, field_name, value_json, provider)
);

CREATE TABLE run_observations (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('NEW_JOB', 'NEW_OBSERVATION', 'DUPLICATE_OBSERVATION')),
  PRIMARY KEY(run_id, observation_id)
);

CREATE TABLE run_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider TEXT,
  target TEXT,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_jobs_last_seen ON jobs(last_seen_at);
CREATE INDEX idx_jobs_company_title ON jobs(normalized_company, normalized_title, normalized_location);
CREATE INDEX idx_observations_job_time ON job_observations(job_id, first_observed_at);
CREATE INDEX idx_observations_provider_external ON job_observations(provider, external_id);
CREATE INDEX idx_observations_content_hash ON job_observations(content_hash);
CREATE INDEX idx_identities_job ON job_identities(job_id);
CREATE INDEX idx_run_observations_run_outcome ON run_observations(run_id, outcome);
CREATE INDEX idx_run_failures_run ON run_failures(run_id);
