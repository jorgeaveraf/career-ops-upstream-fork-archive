CREATE TABLE rejection_feedback (
  id TEXT PRIMARY KEY,
  decision_action_id TEXT NOT NULL UNIQUE REFERENCES human_actions(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  observation_id TEXT REFERENCES job_observations(id) ON DELETE SET NULL,
  candidate_snapshot_json TEXT NOT NULL DEFAULT '{}',
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  human_decision TEXT NOT NULL CHECK (human_decision = 'REJECT'),
  raw_notes TEXT NOT NULL DEFAULT '',
  structured_reason TEXT,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action_source TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  incorporated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE preference_signals (
  id TEXT PRIMARY KEY,
  signal_key TEXT NOT NULL UNIQUE,
  level TEXT NOT NULL CHECK (level IN ('OBSERVATION', 'SOFT_SIGNAL', 'POLICY_CANDIDATE', 'HARD_RULE')),
  category TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_count INTEGER NOT NULL CHECK (evidence_count > 0),
  supporting_rejection_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  score_adjustment INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  version TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE application_enrichment_requests (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  source_observation_id TEXT REFERENCES job_observations(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL,
  current_rank INTEGER,
  research_state_json TEXT NOT NULL DEFAULT '{}',
  package_state TEXT NOT NULL DEFAULT 'NOT_CREATED',
  human_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'IN_PROGRESS', 'READY', 'FAILED', 'CANCELLED')),
  decision_action_id TEXT NOT NULL REFERENCES human_actions(id) ON DELETE RESTRICT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_rejection_feedback_job_time ON rejection_feedback(job_id, created_at DESC);
CREATE INDEX idx_rejection_feedback_reason ON rejection_feedback(structured_reason, created_at DESC);
CREATE INDEX idx_preference_signals_active ON preference_signals(active, level, category);
CREATE INDEX idx_enrichment_requests_status_time ON application_enrichment_requests(status, requested_at);
CREATE INDEX idx_enrichment_requests_job ON application_enrichment_requests(job_id, requested_at DESC);
