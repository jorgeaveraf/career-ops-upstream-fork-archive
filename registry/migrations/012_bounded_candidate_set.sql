CREATE TABLE candidate_selection_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  rules_version TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  threshold INTEGER NOT NULL CHECK (threshold BETWEEN 0 AND 100),
  fill_to_capacity INTEGER NOT NULL DEFAULT 0 CHECK (fill_to_capacity IN (0, 1)),
  raw_count INTEGER NOT NULL DEFAULT 0 CHECK (raw_count >= 0),
  pass_count INTEGER NOT NULL DEFAULT 0 CHECK (pass_count >= 0),
  reject_count INTEGER NOT NULL DEFAULT 0 CHECK (reject_count >= 0),
  unknown_count INTEGER NOT NULL DEFAULT 0 CHECK (unknown_count >= 0),
  active_count INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE candidate_filter_decisions (
  id TEXT PRIMARY KEY,
  decision_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('PASS', 'REJECT', 'UNKNOWN')),
  preliminary_score INTEGER NOT NULL CHECK (preliminary_score BETWEEN 0 AND 100),
  freshness_days INTEGER,
  source TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL DEFAULT '',
  pool_only INTEGER NOT NULL DEFAULT 0 CHECK (pool_only IN (0, 1)),
  evidence_weak INTEGER NOT NULL DEFAULT 0 CHECK (evidence_weak IN (0, 1)),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  rules_version TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  UNIQUE(run_id, job_id)
);

CREATE INDEX idx_candidate_filter_run_outcome ON candidate_filter_decisions(run_id, outcome);
CREATE INDEX idx_candidate_filter_job ON candidate_filter_decisions(job_id, decided_at DESC);

CREATE TABLE active_candidates (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  selection_run_id TEXT NOT NULL REFERENCES runs(id),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'CARRYOVER', 'EXPIRED', 'DISCARDED', 'ACTED', 'SUPERSEDED')),
  entered_at TEXT NOT NULL,
  last_reviewed_at TEXT NOT NULL,
  state_reason TEXT NOT NULL,
  preliminary_score INTEGER NOT NULL CHECK (preliminary_score BETWEEN 0 AND 100),
  freshness_days INTEGER,
  source TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL DEFAULT '',
  previous_rank INTEGER,
  selection_rank INTEGER,
  rules_version TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_active_candidates_state_rank ON active_candidates(state, selection_rank, job_id);

CREATE TABLE active_candidate_transitions (
  id TEXT PRIMARY KEY,
  transition_key TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN ('ACTIVE', 'CARRYOVER', 'EXPIRED', 'DISCARDED', 'ACTED', 'SUPERSEDED')),
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE INDEX idx_candidate_transitions_job ON active_candidate_transitions(job_id, changed_at DESC);

CREATE TABLE daily_priority_snapshots (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES job_observations(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank > 0),
  previous_rank INTEGER,
  movement TEXT NOT NULL,
  final_priority_score INTEGER NOT NULL CHECK (final_priority_score BETWEEN 0 AND 100),
  eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('ELIGIBLE', 'INELIGIBLE', 'UNKNOWN')),
  candidate_fit_score INTEGER NOT NULL CHECK (candidate_fit_score BETWEEN 0 AND 100),
  opportunity_score INTEGER NOT NULL CHECK (opportunity_score BETWEEN 0 AND 100),
  decision TEXT NOT NULL CHECK (decision IN ('SHORTLIST', 'CONSIDER', 'REVIEW', 'REJECT')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  pool_only INTEGER NOT NULL DEFAULT 0 CHECK (pool_only IN (0, 1)),
  evidence_weak INTEGER NOT NULL DEFAULT 0 CHECK (evidence_weak IN (0, 1)),
  is_top_10 INTEGER NOT NULL DEFAULT 0 CHECK (is_top_10 IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, job_id),
  UNIQUE(run_id, rank)
);

CREATE INDEX idx_daily_priority_date_rank ON daily_priority_snapshots(snapshot_date DESC, rank);

CREATE TABLE semantic_funnel_metrics (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'candidate_selection',
  stage TEXT NOT NULL CHECK (stage IN (
    'RAW_DISCOVERED', 'NORMALIZED', 'UNIQUE_JOBS',
    'FILTER_PASS', 'FILTER_REJECT', 'FILTER_UNKNOWN', 'ACTIVE_SET',
    'ELIGIBILITY_ELIGIBLE', 'ELIGIBILITY_INELIGIBLE', 'ELIGIBILITY_UNKNOWN',
    'RANKED', 'TOP_10', 'DEEP_EVALUATED', 'PACKAGE_READY'
  )),
  count INTEGER NOT NULL CHECK (count >= 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(run_id, scope, stage)
);

CREATE INDEX idx_semantic_funnel_stage ON semantic_funnel_metrics(stage, recorded_at DESC);
