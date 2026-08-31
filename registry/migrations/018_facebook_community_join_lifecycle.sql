ALTER TABLE facebook_communities ADD COLUMN join_status TEXT NOT NULL DEFAULT 'NONE'
  CHECK (join_status IN ('NONE','JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','ALREADY_JOINED','JOIN_FAILED','CHALLENGE','AUTH_REQUIRED','POLICY_BLOCKED'));
ALTER TABLE facebook_communities ADD COLUMN suppressed_at TEXT;
ALTER TABLE facebook_communities ADD COLUMN suppression_reason TEXT;
ALTER TABLE facebook_communities ADD COLUMN suppression_action_id TEXT REFERENCES human_actions(id) ON DELETE SET NULL;

CREATE TABLE facebook_community_join_executions (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES facebook_communities(id) ON DELETE CASCADE,
  authorization_action_id TEXT NOT NULL UNIQUE REFERENCES human_actions(id) ON DELETE RESTRICT,
  authorized_url TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','ALREADY_JOINED','JOIN_FAILED','CHALLENGE','AUTH_REQUIRED','POLICY_BLOCKED')),
  click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0 AND click_count <= 1),
  check_count INTEGER NOT NULL DEFAULT 0 CHECK (check_count >= 0),
  reason TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_facebook_join_execution_community ON facebook_community_join_executions(community_id, updated_at DESC);
CREATE INDEX idx_facebook_communities_suppression ON facebook_communities(suppressed_at, quality_score DESC);
