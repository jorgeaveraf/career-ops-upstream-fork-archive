CREATE TABLE browser_discovery_metrics (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  jobs_found INTEGER NOT NULL DEFAULT 0 CHECK (jobs_found >= 0),
  jobs_valid INTEGER NOT NULL DEFAULT 0 CHECK (jobs_valid >= 0),
  jobs_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (jobs_duplicate >= 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(run_id, provider)
);

CREATE INDEX idx_browser_discovery_metrics_provider ON browser_discovery_metrics(provider, recorded_at DESC);
