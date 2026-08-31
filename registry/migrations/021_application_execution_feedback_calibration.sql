CREATE TABLE application_execution_authorizations (
  id TEXT PRIMARY KEY,
  authorization_key TEXT NOT NULL UNIQUE,
  decision_action_id TEXT NOT NULL UNIQUE REFERENCES human_actions(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  enrichment_request_id TEXT NOT NULL REFERENCES application_enrichment_requests(id) ON DELETE RESTRICT,
  package_id TEXT NOT NULL REFERENCES application_packages(id) ON DELETE RESTRICT,
  package_hash TEXT NOT NULL,
  execution_plan_json TEXT NOT NULL,
  execution_plan_hash TEXT NOT NULL,
  authorization_source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('APPROVED_TO_APPLY','EXECUTING','APPLIED','PARTIALLY_APPLIED','NEEDS_HUMAN','FAILED','CANCELLED')),
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE application_executions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  authorization_id TEXT NOT NULL UNIQUE REFERENCES application_execution_authorizations(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('APPROVED_TO_APPLY','EXECUTING','APPLIED','PARTIALLY_APPLIED','NEEDS_HUMAN','FAILED','CANCELLED')),
  primary_channel TEXT NOT NULL CHECK(primary_channel IN ('ATS','EMAIL','PLATFORM','MANUAL_EXTERNAL','UNKNOWN')),
  secondary_channel TEXT NOT NULL DEFAULT 'NONE' CHECK(secondary_channel IN ('NONE','EMAIL','LINKEDIN','FACEBOOK','INSTAGRAM')),
  current_stage TEXT NOT NULL,
  confirmation_json TEXT NOT NULL DEFAULT '{}',
  blocker_json TEXT NOT NULL DEFAULT '{}',
  outreach_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE application_execution_events (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES application_executions(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  stage TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);

CREATE TABLE application_upload_evidence (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES application_executions(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  expected_hash TEXT NOT NULL,
  observed_hash TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  UNIQUE(execution_id, artifact_kind)
);

CREATE TABLE lifecycle_feedback_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  source_action_id TEXT REFERENCES human_actions(id) ON DELETE SET NULL,
  source_execution_id TEXT REFERENCES application_executions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK(dimension IN ('USER_PREFERENCE','MARKET_RESPONSE','SOURCE_QUALITY','APPLICATION_EFFECTIVENESS','COMMUNITY_SIGNAL')),
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  polarity INTEGER NOT NULL CHECK(polarity IN (-1,0,1)),
  weight REAL NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE calibration_signals (
  id TEXT PRIMARY KEY,
  signal_key TEXT NOT NULL UNIQUE,
  dimension TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  evidence_count INTEGER NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  raw_weight REAL NOT NULL,
  adjustment INTEGER NOT NULL CHECK(adjustment >= -6 AND adjustment <= 6),
  supporting_event_ids_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  version TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE calibration_policy_candidates (
  id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL UNIQUE,
  proposal TEXT NOT NULL,
  dimension TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  evidence_count INTEGER NOT NULL,
  supporting_event_ids_json TEXT NOT NULL,
  expected_impact TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(status IN ('PROPOSED','APPROVED','REJECTED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_application_execution_status ON application_executions(status, updated_at);
CREATE INDEX idx_lifecycle_feedback_scope ON lifecycle_feedback_events(dimension, scope_type, scope_value, occurred_at);
CREATE INDEX idx_calibration_signals_active ON calibration_signals(active, dimension, scope_type);
