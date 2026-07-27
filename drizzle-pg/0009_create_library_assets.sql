-- Migration 0009: Create library_assets table
-- Client Asset Library — stores R2 keys for all generated assets.
-- Assets auto-expire 90 days from creation.

CREATE TABLE IF NOT EXISTS library_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  brand_id TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  thumbnail_path TEXT,
  mime_type TEXT,
  file_size INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_library_assets_user_id ON library_assets(user_id);
CREATE INDEX idx_library_assets_type ON library_assets(type);
CREATE INDEX idx_library_assets_expires_at ON library_assets(expires_at);
CREATE INDEX idx_library_assets_user_brand ON library_assets(user_id, brand_id);
