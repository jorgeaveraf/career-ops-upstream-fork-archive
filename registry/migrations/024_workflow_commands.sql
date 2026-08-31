CREATE TABLE workflow_commands (
  command_id TEXT PRIMARY KEY,
  command_type TEXT NOT NULL CHECK(command_type IN ('jobs.sync','communities.sync')),
  correlation_id TEXT NOT NULL,
  source TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('RECEIVED','PROCESSING','SUCCESS','FAILED','NEEDS_HUMAN','CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  payload_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  result_summary TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  error_message TEXT,
  pubsub_message_id TEXT,
  version TEXT NOT NULL
);

CREATE INDEX idx_workflow_commands_recovery
  ON workflow_commands(status, received_at, command_id);

CREATE INDEX idx_workflow_commands_type_recent
  ON workflow_commands(command_type, requested_at DESC);
