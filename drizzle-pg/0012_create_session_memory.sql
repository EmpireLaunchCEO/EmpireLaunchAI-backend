-- Migration 0012: Durable AI Memory
-- Persists "locked"/confirmed decisions per user (+ optional brand) so the
-- Studio AI Router does NOT re-ask questions already answered across sessions.
CREATE TABLE IF NOT EXISTS session_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  brand_id TEXT,
  locked_facts JSONB NOT NULL DEFAULT '{}',
  last_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Index for user-scoped lookups (one row per user, optional per-brand rows)
CREATE INDEX IF NOT EXISTS idx_session_memory_user ON session_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_session_memory_user_brand ON session_memory(user_id, brand_id);
