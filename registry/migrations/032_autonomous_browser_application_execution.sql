ALTER TABLE application_executions ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'GENERIC_BROWSER'
  CHECK(execution_mode IN ('NATIVE','GENERIC_BROWSER','MANUAL_SECURITY_BOUNDARY'));
ALTER TABLE application_executions ADD COLUMN batch_id TEXT;
ALTER TABLE application_executions ADD COLUMN mutation_state TEXT NOT NULL DEFAULT 'PRE_SUBMIT'
  CHECK(mutation_state IN ('PRE_SUBMIT','SUBMIT_INTENT_RECORDED','SUBMIT_ATTEMPTED','POST_SUBMIT','VERIFICATION_UNKNOWN'));
ALTER TABLE application_executions ADD COLUMN session_context_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE application_execution_steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES application_executions(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  step_type TEXT NOT NULL CHECK(step_type IN (
    'application_started','account_created','email_verified','form_completed',
    'submit_intent_recorded','submit_attempted','application_confirmed','security_blocked'
  )),
  phase TEXT NOT NULL CHECK(phase IN ('PRE_SUBMIT','POST_SUBMIT','TERMINAL')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  UNIQUE(execution_id, step_key)
);

CREATE TABLE platform_accounts (
  id TEXT PRIMARY KEY,
  platform_key TEXT NOT NULL,
  account_email TEXT NOT NULL,
  profile_identity TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING_VERIFICATION','ACTIVE','REAUTH_REQUIRED','SECURITY_BLOCKED','DISABLED')),
  credential_reference TEXT,
  created_at TEXT NOT NULL,
  last_verified_at TEXT,
  application_history_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE(platform_key, account_email)
);

CREATE TABLE signup_verification_requests (
  id TEXT PRIMARY KEY,
  platform_account_id TEXT NOT NULL REFERENCES platform_accounts(id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES application_executions(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','VERIFIED','EXPIRED','SECURITY_BLOCKED','FAILED')),
  correlation_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE application_execution_batches (
  id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','PARTIAL','FAILED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  notification_delivery_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE application_form_patterns (
  id TEXT PRIMARY KEY,
  pattern_key TEXT NOT NULL UNIQUE,
  platform_key TEXT NOT NULL,
  form_signature TEXT NOT NULL,
  mappings_json TEXT NOT NULL DEFAULT '[]',
  success_patterns_json TEXT NOT NULL DEFAULT '[]',
  observations INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_application_steps_execution ON application_execution_steps(execution_id, occurred_at);
CREATE INDEX idx_platform_accounts_status ON platform_accounts(status, updated_at);
CREATE INDEX idx_signup_verification_status ON signup_verification_requests(status, requested_at);
CREATE INDEX idx_application_batches_status ON application_execution_batches(status, started_at);
