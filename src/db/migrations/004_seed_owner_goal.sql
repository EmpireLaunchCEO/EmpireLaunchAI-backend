-- Migration: Seed owner user and goal/empire record
-- Purpose: Ensure the owner has a user + goal record after fresh database deployment
-- Date: 2026-07-21

-- 1. Create the owner user if not exists (beta user ID)
INSERT INTO users (id, email, terms_accepted_version, business_slots, tier, is_locked, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', 'stacipeabody@gmail.com', 1, 10, 'OWNER_MASTER', false, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = '00000000-0000-0000-0000-000000000000');

-- 2. Create the owner's goal/empire if no goals exist yet
INSERT INTO goals (user_id, title, description, status, archetype, approval_required, auto_post, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000000', 'Staci Empire', 'Empire Niche: Digital Products.', 'active', 'SELLER', false, false, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM goals);
