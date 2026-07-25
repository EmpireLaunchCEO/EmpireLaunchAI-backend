-- Migration: Add missing columns to master_assets table
-- Date: 2026-07-25
ALTER TABLE master_assets ADD COLUMN IF NOT EXISTS style_dna_source TEXT;
ALTER TABLE master_assets ADD COLUMN IF NOT EXISTS style_dna_strand_ids JSONB;
ALTER TABLE master_assets ADD COLUMN IF NOT EXISTS master_pdf_url TEXT;
