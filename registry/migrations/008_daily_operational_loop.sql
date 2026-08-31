CREATE TABLE operational_runs (
  id TEXT PRIMARY KEY,
  discovery_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  errors_json TEXT NOT NULL DEFAULT '[]',
  jobs_found INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL DEFAULT 0,
  shortlisted INTEGER NOT NULL DEFAULT 0,
  evaluations_completed INTEGER NOT NULL DEFAULT 0,
  packages_ready INTEGER NOT NULL DEFAULT 0,
  sheet_synced INTEGER NOT NULL DEFAULT 0 CHECK (sheet_synced IN (0, 1)),
  notification_required INTEGER NOT NULL DEFAULT 0 CHECK (notification_required IN (0, 1)),
  notification_sent INTEGER NOT NULL DEFAULT 0 CHECK (notification_sent IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  operational_run_id TEXT NOT NULL REFERENCES operational_runs(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL,
  provider TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SENT', 'FAILED', 'SKIPPED')),
  subject TEXT NOT NULL,
  error TEXT,
  provider_message_id TEXT,
  attempted_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(operational_run_id, channel)
);

CREATE INDEX idx_operational_runs_started ON operational_runs(started_at DESC);
CREATE INDEX idx_notification_deliveries_run ON notification_deliveries(operational_run_id, attempted_at DESC);
