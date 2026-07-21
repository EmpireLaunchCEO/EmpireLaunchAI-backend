-- Migration: Add archetype, approval_required, and auto_post columns to goals table
-- Purpose: Support empire archetype classification and autonomous posting controls
-- Date: 2026-07-21
ALTER TABLE goals ADD COLUMN IF NOT EXISTS archetype TEXT DEFAULT 'SELLER' NOT NULL;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS approval_required BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS auto_post BOOLEAN DEFAULT false NOT NULL;
