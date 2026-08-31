CREATE TABLE workflow_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  command_id TEXT,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  event_version TEXT NOT NULL,
  dedupe_key TEXT,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_workflow_events_dedupe ON workflow_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_workflow_events_correlation ON workflow_events(correlation_id, occurred_at, event_id);
CREATE INDEX idx_workflow_events_aggregate ON workflow_events(aggregate_type, aggregate_id, occurred_at, event_id);
CREATE INDEX idx_workflow_events_type ON workflow_events(event_type, occurred_at);
CREATE INDEX idx_workflow_events_occurred ON workflow_events(occurred_at, event_id);
CREATE INDEX idx_workflow_events_command ON workflow_events(command_id, occurred_at) WHERE command_id IS NOT NULL;

CREATE TRIGGER workflow_events_immutable_update
BEFORE UPDATE ON workflow_events BEGIN
  SELECT RAISE(ABORT, 'workflow_events are immutable');
END;

CREATE TRIGGER workflow_events_immutable_delete
BEFORE DELETE ON workflow_events BEGIN
  SELECT RAISE(ABORT, 'workflow_events are immutable');
END;
