CREATE TABLE facebook_community_monitor_metrics (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  community_id TEXT NOT NULL REFERENCES facebook_communities(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  posts_inspected INTEGER NOT NULL DEFAULT 0,
  recent_unique_posts INTEGER NOT NULL DEFAULT 0,
  classifications_json TEXT NOT NULL DEFAULT '{}',
  opportunities_found INTEGER NOT NULL DEFAULT 0,
  authenticity_average REAL NOT NULL DEFAULT 0,
  authenticity_passed INTEGER NOT NULL DEFAULT 0,
  acquisition_observations INTEGER NOT NULL DEFAULT 0,
  new_jobs INTEGER NOT NULL DEFAULT 0,
  accepted_candidates INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  challenges INTEGER NOT NULL DEFAULT 0,
  useful_signal_ratio REAL NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(run_id, community_id)
);
CREATE INDEX idx_facebook_monitor_metrics_community
  ON facebook_community_monitor_metrics(community_id, checked_at DESC);
