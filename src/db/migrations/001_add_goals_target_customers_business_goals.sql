-- Migration: Add targetCustomers and businessGoals columns to goals table
-- Purpose: Allow users to specify target customer demographics and business goals for their empire
-- Date: 2026-07-12

ALTER TABLE goals ADD COLUMN IF NOT EXISTS target_customers TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS business_goals TEXT;
