-- Migration: Add slotIndex to goals table for multi-brand data isolation
-- Purpose: Each brand slot (0,1,2) gets its own goal record scoped to the same userId
-- Date: 2026-07-24
ALTER TABLE goals ADD COLUMN IF NOT EXISTS slot_index INTEGER DEFAULT 0;
