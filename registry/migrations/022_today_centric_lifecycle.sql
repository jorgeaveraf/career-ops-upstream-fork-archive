ALTER TABLE application_enrichment_requests
  ADD COLUMN enrichment_completion_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE application_human_answers (
  id TEXT PRIMARY KEY,
  answer_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  execution_id TEXT REFERENCES application_executions(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  normalized_field TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'JOB' CHECK(scope IN ('JOB','GLOBAL')),
  source_action_id TEXT REFERENCES human_actions(id) ON DELETE SET NULL,
  human_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_application_human_answers_job
  ON application_human_answers(job_id, updated_at DESC);

CREATE TABLE workflow_request_receipts (
  request_type TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  processed_at TEXT NOT NULL,
  PRIMARY KEY(request_type, requested_at)
);
