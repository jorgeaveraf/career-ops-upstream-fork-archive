CREATE TABLE browser_task_telemetry (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('DISCOVERY', 'ENRICHMENT')),
  source TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  planned_url TEXT NOT NULL,
  final_url TEXT,
  page_title TEXT,
  page_classification TEXT NOT NULL,
  auth_observed INTEGER NOT NULL DEFAULT 0,
  expected_selector TEXT,
  selectors_version TEXT,
  readiness_ms INTEGER,
  time_to_first_results_ms INTEGER,
  scroll_passes INTEGER NOT NULL DEFAULT 0,
  cards_seen INTEGER NOT NULL DEFAULT 0,
  unique_cards INTEGER NOT NULL DEFAULT 0,
  extracted_records INTEGER NOT NULL DEFAULT 0,
  detail_pages_opened INTEGER NOT NULL DEFAULT 0,
  descriptions_acquired INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'SUCCESS_RESULTS','SUCCESS_EMPTY','AUTH_REQUIRED','CHALLENGE','CAPTCHA','WRONG_PAGE',
    'SELECTOR_CHANGED','RESULTS_TIMEOUT','NAVIGATION_TIMEOUT','EXTRACTION_FAILED','POLICY_BLOCKED'
  )),
  phase_durations_json TEXT NOT NULL DEFAULT '{}',
  state_history_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  errors_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(run_id, task_id)
);

CREATE TABLE browser_scroll_pass_telemetry (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  pass INTEGER NOT NULL,
  cards_before INTEGER NOT NULL,
  cards_after INTEGER NOT NULL,
  unique_added INTEGER NOT NULL,
  result_fingerprint TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(run_id, task_id, pass),
  FOREIGN KEY(run_id, task_id) REFERENCES browser_task_telemetry(run_id, task_id) ON DELETE CASCADE
);

CREATE INDEX idx_browser_task_semantic_outcome ON browser_task_telemetry(source, outcome, finished_at DESC);
CREATE INDEX idx_browser_task_semantic_mode ON browser_task_telemetry(mode, finished_at DESC);
