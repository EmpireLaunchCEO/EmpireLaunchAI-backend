-- Migration 0015: real sessions
--
-- Until now `mobileAuth` minted a session for ANY caller — an unauthenticated
-- request carrying `x-user-id` was logged in as that user, and a Bearer token
-- that matched nothing auto-provisioned a user row. Identity was whatever the
-- request claimed.
--
-- `auth_sessions` is the only place a session now lives. The raw token is
-- returned to the caller once and never stored: `token_hash` is the SHA-256 hex
-- digest of it, so this table (or a backup of it) cannot be replayed as a token.
-- `expires_at` is 30 days from creation; `last_used_at` is touched on use.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMP,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
  ON auth_sessions (user_id);

CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
  ON auth_sessions (expires_at);
