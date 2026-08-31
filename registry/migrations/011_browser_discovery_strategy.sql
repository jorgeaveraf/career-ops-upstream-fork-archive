CREATE TABLE browser_discovery_task_results (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
  jobs_found INTEGER NOT NULL DEFAULT 0 CHECK (jobs_found >= 0),
  jobs_valid INTEGER NOT NULL DEFAULT 0 CHECK (jobs_valid >= 0),
  jobs_rejected INTEGER NOT NULL DEFAULT 0 CHECK (jobs_rejected >= 0),
  jobs_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (jobs_duplicate >= 0),
  explanation_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  PRIMARY KEY(run_id, task_id)
);

CREATE TABLE browser_discovery_task_observations (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('NEW_JOB', 'NEW_OBSERVATION', 'DUPLICATE_OBSERVATION')),
  PRIMARY KEY(run_id, task_id, observation_id),
  FOREIGN KEY(run_id, task_id) REFERENCES browser_discovery_task_results(run_id, task_id) ON DELETE CASCADE
);

CREATE INDEX idx_browser_task_results_strategy ON browser_discovery_task_results(provider, strategy_id, finished_at DESC);
CREATE INDEX idx_browser_task_observations_observation ON browser_discovery_task_observations(observation_id);
