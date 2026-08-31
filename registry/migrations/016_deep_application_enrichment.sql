ALTER TABLE application_enrichment_requests RENAME TO application_enrichment_requests_v2a;

CREATE TABLE application_enrichment_requests (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  source_observation_id TEXT REFERENCES job_observations(id) ON DELETE SET NULL,
  requested_at TEXT NOT NULL,
  current_rank INTEGER,
  research_state_json TEXT NOT NULL DEFAULT '{}',
  package_state TEXT NOT NULL DEFAULT 'NOT_CREATED',
  human_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('PENDING','RESEARCHING','EVALUATING','GENERATING_PACKAGE','READY_FOR_REVIEW','BLOCKED','FAILED','CANCELLED')),
  decision_action_id TEXT NOT NULL REFERENCES human_actions(id) ON DELETE RESTRICT,
  claimed_by_run_id TEXT,
  claim_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  current_stage_started_at TEXT,
  terminal_reason TEXT,
  last_error_code TEXT,
  research_plan_json TEXT NOT NULL DEFAULT '{}',
  research_report_json TEXT NOT NULL DEFAULT '{}',
  evaluation_id TEXT REFERENCES job_evaluations(id) ON DELETE SET NULL,
  package_id TEXT REFERENCES application_packages(id) ON DELETE SET NULL,
  contact_research_id TEXT REFERENCES contact_research(id) ON DELETE SET NULL,
  application_plan_json TEXT NOT NULL DEFAULT '{}',
  contact_plan_json TEXT NOT NULL DEFAULT '{}',
  artifact_manifest_json TEXT NOT NULL DEFAULT '{}',
  input_hash TEXT,
  output_refs_json TEXT NOT NULL DEFAULT '[]',
  cancelled_at TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO application_enrichment_requests(
  id, request_key, job_id, source_observation_id, requested_at, current_rank,
  research_state_json, package_state, human_notes, status, decision_action_id,
  cancelled_at, cancellation_reason, created_at, updated_at
)
SELECT id, request_key, job_id, source_observation_id, requested_at, current_rank,
  research_state_json, package_state, human_notes,
  CASE status WHEN 'IN_PROGRESS' THEN 'RESEARCHING' WHEN 'READY' THEN 'READY_FOR_REVIEW' ELSE status END,
  decision_action_id, cancelled_at, cancellation_reason, created_at, updated_at
FROM application_enrichment_requests_v2a;

DROP TABLE application_enrichment_requests_v2a;

CREATE TABLE application_enrichment_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES application_enrichment_requests(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  run_id TEXT,
  lifecycle_version TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  output_refs_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL
);

CREATE TABLE application_enrichment_evidence (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES application_enrichment_requests(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  raw_snippet TEXT NOT NULL DEFAULT '',
  raw_hash TEXT NOT NULL,
  normalized_field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  identity_status TEXT NOT NULL CHECK (identity_status IN ('CONFIRMED','UNCERTAIN')),
  resolver_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(request_id, raw_hash, normalized_field)
);

CREATE INDEX idx_enrichment_requests_status_time ON application_enrichment_requests(status, requested_at);
CREATE INDEX idx_enrichment_requests_job ON application_enrichment_requests(job_id, requested_at DESC);
CREATE INDEX idx_enrichment_requests_lease ON application_enrichment_requests(status, claim_expires_at);
CREATE INDEX idx_enrichment_events_request_time ON application_enrichment_events(request_id, occurred_at);
CREATE INDEX idx_enrichment_evidence_request ON application_enrichment_evidence(request_id, normalized_field);
