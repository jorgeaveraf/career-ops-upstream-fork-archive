ALTER TABLE notification_deliveries RENAME TO notification_deliveries_v1;

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES workflow_events(event_id) ON DELETE RESTRICT,
  operational_run_id TEXT REFERENCES operational_runs(id) ON DELETE RESTRICT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('CRITICAL','HIGH','NORMAL','LOW')),
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  recipient_identity TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED','SUPPRESSED','DISABLED','AMBIGUOUS')),
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  template_version TEXT NOT NULL,
  trigger_snapshot_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  dedupe_key TEXT NOT NULL UNIQUE
);

INSERT INTO notification_deliveries(
  id,event_id,operational_run_id,aggregate_type,aggregate_id,correlation_id,
  notification_type,priority,channel,recipient_identity,provider,provider_message_id,
  status,subject,body_text,template_version,trigger_snapshot_json,error_code,error,
  attempt_count,max_attempts,next_attempt_at,last_attempt_at,created_at,sent_at,dedupe_key
)
SELECT
  id,NULL,operational_run_id,'OPERATIONAL_RUN',operational_run_id,operational_run_id,
  'DAILY_SUMMARY','LOW',channel,recipient,provider,provider_message_id,
  CASE status WHEN 'SENT' THEN 'SENT' WHEN 'FAILED' THEN 'FAILED' ELSE 'SUPPRESSED' END,
  subject,'','1.0','{}',NULL,error,1,1,NULL,attempted_at,attempted_at,sent_at,
  'legacy:' || operational_run_id || ':' || channel
FROM notification_deliveries_v1;

DROP TABLE notification_deliveries_v1;

CREATE INDEX idx_notification_outbox_status ON notification_deliveries(status,next_attempt_at,created_at);
CREATE INDEX idx_notification_outbox_event ON notification_deliveries(event_id,notification_type);
CREATE INDEX idx_notification_outbox_aggregate ON notification_deliveries(aggregate_type,aggregate_id,created_at DESC);
CREATE INDEX idx_notification_outbox_correlation ON notification_deliveries(correlation_id,created_at);
