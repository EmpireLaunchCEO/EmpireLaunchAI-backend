-- Migration: Add library_assets table for client asset library
-- Assets auto-expire 90 days after creation. Only metadata in DB, files on disk.

CREATE TABLE IF NOT EXISTS library_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  brand_id UUID,
  type TEXT NOT NULL,
  name TEXT,
  file_path TEXT,
  thumbnail_path TEXT,
  mime_type TEXT,
  file_size INTEGER,
  metadata JSONB,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Index for fast user+type queries (the main listing page)
CREATE INDEX IF NOT EXISTS idx_library_assets_user_type ON library_assets(user_id, type);
CREATE INDEX IF NOT EXISTS idx_library_assets_expires ON library_assets(expires_at);
