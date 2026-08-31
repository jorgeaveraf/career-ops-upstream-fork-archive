CREATE TABLE worker_work_items (
  id TEXT PRIMARY KEY,
  work_key TEXT NOT NULL UNIQUE,
  work_type TEXT NOT NULL CHECK(work_type IN ('ENRICHMENT','APPLICATION','OUTREACH')),
  worker_name TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','WORKING','WAITING','SCHEDULED','COMPLETED','BLOCKED','FAILED','CANCELLED')),
  queued_at TEXT NOT NULL,
  wake_requested_at TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  due_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_worker_work_items_queue ON worker_work_items(work_type,status,due_at,queued_at);
CREATE INDEX idx_worker_work_items_job ON worker_work_items(job_id,updated_at);

CREATE TABLE worker_wake_attempts (
  id TEXT PRIMARY KEY,
  worker_name TEXT NOT NULL,
  work_type TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('WAKE_STARTED','ALREADY_RUNNING','NO_WORK','FAILED_RECOVERABLE','FAILED_PERSISTENT')),
  queue_depth INTEGER NOT NULL DEFAULT 0,
  process_state TEXT,
  launch_agent_label TEXT,
  error_code TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  requested_at TEXT NOT NULL
);
CREATE INDEX idx_worker_wake_attempts_worker ON worker_wake_attempts(worker_name,requested_at);

CREATE TABLE human_questions (
  question_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  application_execution_id TEXT NOT NULL REFERENCES application_executions(id) ON DELETE RESTRICT,
  question_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  help_text TEXT NOT NULL,
  answer_type TEXT NOT NULL,
  allowed_values_json TEXT NOT NULL DEFAULT '[]',
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK(sensitive IN (0,1)),
  source_context_json TEXT NOT NULL DEFAULT '{}',
  blocking_work_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('OPEN','ANSWERED','CANCELLED')),
  answer_action_id TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_human_questions_open_field ON human_questions(application_execution_id,field_key) WHERE status='OPEN';
