CREATE TABLE browser_research_observations (
  id TEXT PRIMARY KEY,
  observation_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('PAGE', 'JOB', 'COMPANY', 'CONTACT')),
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('direct', 'parsed', 'normalized', 'inferred')),
  data_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  first_retrieved_at TEXT NOT NULL,
  last_retrieved_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE browser_research_run_observations (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  observation_id TEXT NOT NULL REFERENCES browser_research_observations(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('NEW', 'DUPLICATE')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(run_id, observation_id)
);

CREATE INDEX idx_browser_research_entity_time ON browser_research_observations(entity_type, last_retrieved_at DESC);
CREATE INDEX idx_browser_research_source_time ON browser_research_observations(source, last_retrieved_at DESC);
