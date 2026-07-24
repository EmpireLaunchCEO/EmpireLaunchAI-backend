-- Migration: Add subscriptions table for Stripe payment verification
-- Purpose: Track real subscription and expansion payments with Stripe session data
-- Date: 2026-07-22

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type TEXT NOT NULL DEFAULT 'subscription', -- 'subscription' or 'expansion'
  stripe_session_id TEXT,
  amount INTEGER, -- in cents
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
