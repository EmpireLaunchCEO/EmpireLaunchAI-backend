-- Migration 0013: clientName + referral attribution
-- 1) users.name — customer full name captured at checkout (frontend sends clientName).
-- 2) referrals — salesperson attribution row per client+referral (commission payouts later).
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL REFERENCES users(id),
  salesperson_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Index for "each client+referral recorded once" lookups and future payout queries.
CREATE INDEX IF NOT EXISTS idx_referrals_client_user ON referrals(client_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_salesperson ON referrals(salesperson_name);