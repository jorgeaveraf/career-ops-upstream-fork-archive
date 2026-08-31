CREATE TABLE application_question_resolutions (
  id TEXT PRIMARY KEY,
  resolution_key TEXT NOT NULL UNIQUE,
  execution_id TEXT NOT NULL REFERENCES application_executions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  platform_key TEXT NOT NULL,
  field_id TEXT NOT NULL,
  question TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  resolution_type TEXT NOT NULL CHECK(resolution_type IN (
    'EXACT_FACT','DERIVED_FACT','POLICY_ANSWER','GENERATED_ANSWER','PREVIOUS_VERIFIED_ANSWER'
  )),
  confidence TEXT NOT NULL CHECK(confidence IN ('HIGH','MEDIUM','LOW')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL,
  reusable INTEGER NOT NULL DEFAULT 0 CHECK(reusable IN (0,1)),
  valid_as_of TEXT,
  resolved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_question_resolutions_semantic
  ON application_question_resolutions(semantic_key, reusable, updated_at DESC);
CREATE INDEX idx_question_resolutions_execution
  ON application_question_resolutions(execution_id, resolved_at);
