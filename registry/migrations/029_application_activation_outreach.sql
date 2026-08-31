CREATE TABLE outreach_authorizations (
  id TEXT PRIMARY KEY,
  authorization_key TEXT NOT NULL UNIQUE,
  decision_action_id TEXT NOT NULL UNIQUE REFERENCES human_actions(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  enrichment_request_id TEXT NOT NULL REFERENCES application_enrichment_requests(id) ON DELETE RESTRICT,
  outreach_plan_json TEXT NOT NULL,
  outreach_plan_hash TEXT NOT NULL,
  authorization_source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('APPROVED_OUTREACH','SENT','NEEDS_HUMAN','VERIFICATION_REQUIRED','FAILED','CANCELLED')),
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outreach_executions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  authorization_id TEXT NOT NULL UNIQUE REFERENCES outreach_authorizations(id) ON DELETE RESTRICT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  contact_id TEXT,
  channel TEXT NOT NULL,
  message_version TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  sender TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('EXECUTING','SENT','NEEDS_HUMAN','VERIFICATION_REQUIRED','FAILED','CANCELLED')),
  provider_confirmation_json TEXT NOT NULL DEFAULT '{}',
  blocker_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_outreach_authorizations_status ON outreach_authorizations(status, approved_at);
CREATE INDEX idx_outreach_executions_status ON outreach_executions(status, updated_at);
