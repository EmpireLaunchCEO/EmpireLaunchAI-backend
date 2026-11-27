-- Migration 0016: users.role
--
-- What an account may SEE AND DO: 'client' | 'sales_rep' | 'demo'.
-- Deliberately separate from `tier`: owner rights stay tier = 'OWNER_MASTER',
-- and this column never grants them. Every existing row becomes a client,
-- which is what every existing row already was.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'client';

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
