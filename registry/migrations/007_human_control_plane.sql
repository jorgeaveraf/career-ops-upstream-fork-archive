CREATE TABLE sheet_sync_state (
  spreadsheet_id TEXT PRIMARY KEY,
  projection_hash TEXT NOT NULL,
  last_push_at TEXT,
  last_pull_at TEXT,
  last_result_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE sheet_sync_runs (
  id TEXT PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('PUSH', 'PULL')),
  projection_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE human_actions (
  id TEXT PRIMARY KEY,
  action_key TEXT NOT NULL UNIQUE,
  spreadsheet_id TEXT NOT NULL,
  tab_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('JOB', 'PERSON', 'FOLLOW_UP', 'UNKNOWN')),
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('APPLIED', 'REJECTED')),
  reason TEXT,
  observed_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  source_hash TEXT NOT NULL
);

CREATE TABLE human_field_state (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('JOB', 'PERSON', 'FOLLOW_UP')),
  entity_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  source_action_id TEXT NOT NULL REFERENCES human_actions(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_id, field_name)
);

CREATE INDEX idx_sheet_sync_runs_sheet_time ON sheet_sync_runs(spreadsheet_id, synced_at DESC);
CREATE INDEX idx_human_actions_entity_time ON human_actions(entity_type, entity_id, observed_at DESC);
CREATE INDEX idx_human_actions_status ON human_actions(status, imported_at DESC);

