CREATE TABLE candidate_research_needs (
  id TEXT PRIMARY KEY,
  need_key TEXT NOT NULL UNIQUE,
  selection_run_id TEXT REFERENCES runs(id),
  assessment_id TEXT REFERENCES job_assessments(id),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  need_type TEXT NOT NULL CHECK (need_type IN (
    'FETCH_FULL_DESCRIPTION', 'CONFIRM_MEXICO_ELIGIBILITY', 'CONFIRM_REMOTE_SCOPE',
    'CONFIRM_EMPLOYMENT_MODEL', 'CONFIRM_COMPENSATION', 'CONFIRM_COMPANY_MARKET',
    'CONFIRM_SCHEDULE', 'RESOLVE_LOCATION_CONFLICT', 'CONFIRM_POSTING_IS_REAL'
  )),
  dimension TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('HIGH', 'MEDIUM', 'LOW')),
  priority_score INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'OBSOLETE', 'BLOCKED')),
  reason TEXT NOT NULL,
  resolution_evidence_json TEXT NOT NULL DEFAULT '[]',
  unified_policy_version TEXT NOT NULL,
  eligibility_rules_version TEXT NOT NULL,
  completeness_version TEXT NOT NULL,
  research_needs_version TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_candidate_research_queue ON candidate_research_needs(status, priority_score DESC, job_id);
CREATE INDEX idx_candidate_research_job ON candidate_research_needs(job_id, observation_id, updated_at DESC);

CREATE TABLE candidate_reassessment_queue (
  id TEXT PRIMARY KEY,
  trigger_key TEXT NOT NULL UNIQUE,
  research_need_id TEXT REFERENCES candidate_research_needs(id),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('EVIDENCE_RESOLVED', 'POLICY_CHANGED', 'NEW_OBSERVATION')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSED')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  policy_hash TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX idx_candidate_reassessment_pending ON candidate_reassessment_queue(status, triggered_at, job_id);

ALTER TABLE daily_priority_snapshots ADD COLUMN evidence_completeness_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE daily_priority_snapshots ADD COLUMN research_needs_json TEXT NOT NULL DEFAULT '[]';
