ALTER TABLE runs RENAME COLUMN status TO legacy_status;

ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'RUNNING'
  CHECK (status IN ('PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'INTERRUPTED'));
ALTER TABLE runs ADD COLUMN created_at TEXT;
ALTER TABLE runs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE runs ADD COLUMN owner_pid INTEGER;

UPDATE runs SET
  status = CASE legacy_status
    WHEN 'completed' THEN 'SUCCESS'
    WHEN 'failed' THEN 'FAILED'
    ELSE 'RUNNING'
  END,
  created_at = started_at,
  heartbeat_at = CASE WHEN legacy_status = 'running' THEN started_at ELSE finished_at END;

CREATE TABLE run_provider_results (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
  observations_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY(run_id, provider, target)
);

CREATE INDEX idx_runs_lifecycle_status ON runs(status, heartbeat_at);
CREATE INDEX idx_run_provider_results_run ON run_provider_results(run_id, provider, target);
