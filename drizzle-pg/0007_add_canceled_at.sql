-- Migration: Add canceledAt to subscriptions for 30-day data retention tracking
-- Date: 2026-07-25
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMP;
