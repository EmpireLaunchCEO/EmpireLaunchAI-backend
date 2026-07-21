-- Migration: Update owner's goal to match current specifications
-- Purpose: Update the existing "EmpireLaunch AI" goal with correct niche
-- Date: 2026-07-21

UPDATE goals 
SET description = 'Empire Niche: Content Creation Platform that is AI powered.',
    status = 'active',
    updated_at = NOW()
WHERE user_id = '00000000-0000-0000-0000-000000000000'
  AND title = 'EmpireLaunch AI'
  AND description != 'Empire Niche: Content Creation Platform that is AI powered.';
