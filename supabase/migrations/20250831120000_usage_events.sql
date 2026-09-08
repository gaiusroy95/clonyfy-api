-- Free/paid quota tracking for editor sessions, saves, and share links.

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  out_dir TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_kind ON usage_events(user_id, kind, created_at);

ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY;
