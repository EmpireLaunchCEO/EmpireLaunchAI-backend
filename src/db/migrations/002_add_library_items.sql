-- Migration: Add library_items table for user design asset library
CREATE TABLE IF NOT EXISTS library_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  category TEXT,
  tags JSONB,
  file_url TEXT,
  thumbnail_url TEXT,
  source_creation_id UUID,
  source_dna_strand_id UUID,
  source_style_dna_id UUID,
  metadata JSONB,
  is_favorite BOOLEAN DEFAULT false NOT NULL,
  is_public BOOLEAN DEFAULT false NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);
