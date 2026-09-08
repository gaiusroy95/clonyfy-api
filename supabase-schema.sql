-- Run this in your Supabase project: SQL Editor > New query

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL DEFAULT '',
  salt TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_renews_at TEXT,
  billing_interval TEXT NOT NULL DEFAULT 'monthly',
  email_verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  verify_expiry BIGINT,
  reset_token TEXT,
  reset_expiry BIGINT,
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  renewal_reminder_sent INTEGER NOT NULL DEFAULT 0,
  usage_alert_sent INTEGER NOT NULL DEFAULT 0,
  google_id TEXT UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  impersonated_by TEXT
);

CREATE TABLE IF NOT EXISTS clones (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  url TEXT NOT NULL,
  out_dir TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  pages INTEGER,
  assets INTEGER,
  api_routes INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  label TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  user_email TEXT,
  plan TEXT NOT NULL,
  amount NUMERIC(12,4) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  method TEXT,
  tx_id TEXT,
  note TEXT,
  promo_code TEXT,
  discount_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
  interval TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT NOT NULL,
  processed_at TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  out_dir TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '/',
  created_at TEXT NOT NULL,
  password_hash TEXT,
  salt TEXT,
  expires_at BIGINT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  out_dir TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_kind ON usage_events(user_id, kind, created_at);

CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  discount_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
  description TEXT,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  plans TEXT NOT NULL DEFAULT '[]',
  valid_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  url TEXT NOT NULL,
  error_summary TEXT,
  logs TEXT,
  started_at TEXT,
  failed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_to TEXT NOT NULL DEFAULT 'all',
  recipient_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_submissions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);

-- Indexes for the queries the app actually runs (lookups + the hourly
-- session/audit cleanup sweeps, which would otherwise full-scan as the
-- tables grow).
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_clones_user_id ON clones(user_id);
CREATE INDEX IF NOT EXISTS idx_clones_out_dir ON clones(out_dir);
CREATE INDEX IF NOT EXISTS idx_clones_started_at ON clones(started_at);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_errors_failed_at ON errors(failed_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- Disable RLS for all tables (service role key bypasses anyway, but this keeps it clean)
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE clones DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE shares DISABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE promo_codes DISABLE ROW LEVEL SECURITY;
ALTER TABLE errors DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;
ALTER TABLE announcements DISABLE ROW LEVEL SECURITY;
ALTER TABLE contact_submissions DISABLE ROW LEVEL SECURITY;
