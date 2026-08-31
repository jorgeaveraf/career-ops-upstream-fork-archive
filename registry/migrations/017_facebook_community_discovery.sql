CREATE TABLE facebook_communities (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC','PRIVATE','UNKNOWN')),
  membership_state TEXT NOT NULL CHECK (membership_state IN ('DISCOVERED','RECOMMENDED','JOIN_REQUIRED','JOINED_CONFIRMED','MONITORING','SKIPPED','REJECTED','LEFT','BLOCKED','UNKNOWN')),
  member_count INTEGER,
  activity_score INTEGER NOT NULL DEFAULT 0,
  opportunity_score INTEGER NOT NULL DEFAULT 0,
  spam_score INTEGER NOT NULL DEFAULT 0,
  quality_score INTEGER NOT NULL DEFAULT 0,
  recommendation TEXT NOT NULL CHECK (recommendation IN ('RECOMMENDED','CONSIDER','LOW_VALUE','REJECTED','UNKNOWN')),
  public_description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  geography_signals_json TEXT NOT NULL DEFAULT '[]',
  why_it_matters TEXT NOT NULL DEFAULT '',
  query TEXT NOT NULL DEFAULT '',
  query_reason TEXT NOT NULL DEFAULT '',
  query_priority TEXT NOT NULL DEFAULT '',
  strategy_revision TEXT NOT NULL,
  candidate_kb_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_checked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE facebook_community_events (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES facebook_communities(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  run_id TEXT,
  action_id TEXT REFERENCES human_actions(id) ON DELETE SET NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL
);

CREATE TABLE facebook_community_feedback (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES facebook_communities(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('NO_ACTION','WANT_TO_JOIN','JOINED','SKIP','REJECT')),
  notes TEXT NOT NULL DEFAULT '',
  action_id TEXT NOT NULL UNIQUE REFERENCES human_actions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE TABLE facebook_community_human_state (
  community_id TEXT NOT NULL REFERENCES facebook_communities(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL CHECK (field_name IN ('membership_decision','notes')),
  value_json TEXT NOT NULL,
  source_action_id TEXT NOT NULL REFERENCES human_actions(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(community_id, field_name)
);

CREATE TABLE facebook_posts (
  id TEXT PRIMARY KEY,
  post_key TEXT NOT NULL UNIQUE,
  community_id TEXT NOT NULL REFERENCES facebook_communities(id) ON DELETE CASCADE,
  external_id TEXT,
  canonical_url TEXT NOT NULL,
  author_display_name TEXT NOT NULL DEFAULT '',
  posted_at TEXT,
  raw_text TEXT NOT NULL DEFAULT '',
  text_hash TEXT NOT NULL,
  links_json TEXT NOT NULL DEFAULT '[]',
  emails_json TEXT NOT NULL DEFAULT '[]',
  image_refs_json TEXT NOT NULL DEFAULT '[]',
  image_evidence_present INTEGER NOT NULL DEFAULT 0 CHECK (image_evidence_present IN (0,1)),
  opportunity_type TEXT NOT NULL CHECK (opportunity_type IN ('JOB','CONTRACT','FREELANCE_PROJECT','HIRING_SIGNAL','NOT_OPPORTUNITY','UNKNOWN')),
  company_name TEXT NOT NULL DEFAULT '',
  company_identity_status TEXT NOT NULL CHECK (company_identity_status IN ('CONFIRMED','LIKELY','UNKNOWN')),
  authenticity_score INTEGER NOT NULL,
  authenticity_band TEXT NOT NULL CHECK (authenticity_band IN ('HIGH','MEDIUM','LOW')),
  authenticity_reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  browser_run_id TEXT NOT NULL,
  observation_id TEXT REFERENCES job_observations(id) ON DELETE SET NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE facebook_monitor_checkpoints (
  community_id TEXT PRIMARY KEY REFERENCES facebook_communities(id) ON DELETE CASCADE,
  last_checked_at TEXT NOT NULL,
  newest_seen_marker TEXT,
  oldest_seen_marker TEXT,
  seen_post_ids_json TEXT NOT NULL DEFAULT '[]',
  run_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_facebook_communities_membership ON facebook_communities(membership_state, quality_score DESC);
CREATE INDEX idx_facebook_community_events_time ON facebook_community_events(community_id, occurred_at);
CREATE INDEX idx_facebook_posts_community_time ON facebook_posts(community_id, posted_at DESC, first_seen_at DESC);
