ALTER TABLE outreach_authorizations ADD COLUMN scheduled_at TEXT;
ALTER TABLE outreach_authorizations ADD COLUMN expires_at TEXT;

ALTER TABLE outreach_executions ADD COLUMN recipient TEXT;
ALTER TABLE outreach_executions ADD COLUMN subject TEXT;
ALTER TABLE outreach_executions ADD COLUMN provider TEXT;
ALTER TABLE outreach_executions ADD COLUMN provider_message_id TEXT;
ALTER TABLE outreach_executions ADD COLUMN provider_thread_id TEXT;
ALTER TABLE outreach_executions ADD COLUMN conversation_url TEXT;
ALTER TABLE outreach_executions ADD COLUMN scheduled_at TEXT;
ALTER TABLE outreach_executions ADD COLUMN sent_at TEXT;
ALTER TABLE outreach_executions ADD COLUMN last_verified_at TEXT;
ALTER TABLE outreach_executions ADD COLUMN response_at TEXT;
ALTER TABLE outreach_executions ADD COLUMN outcome TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE outreach_executions ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_outreach_authorizations_schedule
  ON outreach_authorizations(status, scheduled_at);
CREATE INDEX idx_outreach_executions_provider_message
  ON outreach_executions(provider, provider_message_id);

