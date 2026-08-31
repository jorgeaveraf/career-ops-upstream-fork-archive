DROP INDEX IF EXISTS idx_facebook_join_execution_community;
ALTER TABLE facebook_community_join_executions RENAME TO facebook_community_join_executions_v18;

CREATE TABLE facebook_community_join_executions (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES facebook_communities(id) ON DELETE CASCADE,
  authorization_action_id TEXT NOT NULL UNIQUE REFERENCES human_actions(id) ON DELETE RESTRICT,
  authorized_url TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','ALREADY_JOINED','JOIN_FAILED','CHALLENGE','AUTH_REQUIRED','POLICY_BLOCKED','VERIFICATION_UNKNOWN')),
  click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0 AND click_count <= 1),
  check_count INTEGER NOT NULL DEFAULT 0 CHECK (check_count >= 0),
  reason TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO facebook_community_join_executions SELECT * FROM facebook_community_join_executions_v18;
DROP TABLE facebook_community_join_executions_v18;
CREATE INDEX idx_facebook_join_execution_community ON facebook_community_join_executions(community_id, updated_at DESC);

ALTER TABLE facebook_communities ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
  CHECK (verification_status IN ('UNVERIFIED','JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','NOT_JOINED','CHALLENGE','AUTH_REQUIRED','VERIFICATION_UNKNOWN'));

CREATE TABLE facebook_community_membership_verifications (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES facebook_communities(id) ON DELETE CASCADE,
  join_execution_id TEXT REFERENCES facebook_community_join_executions(id) ON DELETE SET NULL,
  verifier_version TEXT NOT NULL,
  previous_state TEXT NOT NULL,
  final_state TEXT NOT NULL CHECK (final_state IN ('JOINED_CONFIRMED','JOIN_REQUESTED','NEEDS_HUMAN','NOT_JOINED','CHALLENGE','AUTH_REQUIRED','VERIFICATION_UNKNOWN')),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  lifecycle_corrected INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_corrected IN (0,1)),
  checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_facebook_membership_verifications_community
  ON facebook_community_membership_verifications(community_id, checked_at DESC);
