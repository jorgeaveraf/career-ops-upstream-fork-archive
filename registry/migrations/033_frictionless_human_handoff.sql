CREATE TABLE human_handoffs (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES application_executions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  batch_id TEXT,
  handoff_type TEXT NOT NULL CHECK(handoff_type IN (
    'CAPTCHA_REQUIRED','MFA_REQUIRED','LOGIN_REAUTH_REQUIRED','SECURITY_CHALLENGE',
    'REAL_HUMAN_FACT_REQUIRED','LEGAL_ATTESTATION_REQUIRED','PLATFORM_CONFIRMATION_REQUIRED'
  )),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','RESOLVED','CANCELLED','STALE')),
  resume_status TEXT NOT NULL CHECK(resume_status IN ('PAUSED_FOR_HUMAN','RESUMING','RESUMED','FAILED')),
  action TEXT NOT NULL,
  instruction TEXT NOT NULL,
  progress TEXT NOT NULL,
  open_url TEXT,
  questions_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  session_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  handoff_resolved_at TEXT,
  resume_started_at TEXT,
  resume_completed_at TEXT,
  resume_result_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX idx_human_handoffs_active_execution
  ON human_handoffs(execution_id) WHERE status='ACTIVE';
CREATE INDEX idx_human_handoffs_queue
  ON human_handoffs(status,resume_status,created_at);
CREATE INDEX idx_human_handoffs_batch
  ON human_handoffs(batch_id,status,created_at);

