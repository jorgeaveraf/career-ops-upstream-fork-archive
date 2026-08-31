CREATE TABLE operational_signals (
  signal_id TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL')),
  component TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','RECOVERING','RECOVERED','ESCALATED','SUPPRESSED','CLOSED')),
  summary TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  recommended_action TEXT NOT NULL,
  auto_recoverable INTEGER NOT NULL DEFAULT 0 CHECK (auto_recoverable IN (0,1)),
  safety_class TEXT NOT NULL CHECK (safety_class IN ('INTERNAL_ONLY','SAFE_IDEMPOTENT_EXTERNAL','AMBIGUOUS_EXTERNAL','HUMAN_DECISION')),
  remediation_action TEXT,
  policy_version TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  detected_event_id TEXT,
  observation_count INTEGER NOT NULL DEFAULT 1,
  flap_count INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolution_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE operational_signal_observations (
  observation_id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES operational_signals(signal_id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  UNIQUE(signal_id, observed_at, summary)
);

CREATE TABLE operational_recovery_attempts (
  attempt_id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES operational_signals(signal_id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT NOT NULL CHECK (result IN ('RUNNING','SUCCEEDED','FAILED','POLICY_BLOCKED')),
  verification_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error TEXT,
  UNIQUE(signal_id, action, attempt)
);

CREATE TABLE operational_watch_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCESS','FAILED','LOCKED')),
  signals_detected INTEGER NOT NULL DEFAULT 0,
  recoveries_attempted INTEGER NOT NULL DEFAULT 0,
  recoveries_succeeded INTEGER NOT NULL DEFAULT 0,
  escalations INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error TEXT
);

CREATE TABLE operational_source_degradations (
  degradation_id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES operational_signals(signal_id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  run_id TEXT,
  reason TEXT NOT NULL,
  started_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(signal_id, source, run_id)
);

CREATE INDEX idx_operational_signals_status ON operational_signals(status, severity, last_seen_at);
CREATE INDEX idx_operational_signals_component ON operational_signals(component, signal_type, last_seen_at);
CREATE INDEX idx_operational_observations_signal ON operational_signal_observations(signal_id, observed_at);
CREATE INDEX idx_operational_recoveries_signal ON operational_recovery_attempts(signal_id, started_at);
CREATE INDEX idx_operational_watch_time ON operational_watch_runs(started_at DESC);
