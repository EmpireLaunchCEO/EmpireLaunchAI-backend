-- Migration 0018: attribution on the referral row + the commission ledger
--
-- 1) `referrals` learns WHO (a rep account) and WHEN (signup vs payment).
--    `source` defaults to 'payment' so every row written before this migration
--    stays valid — those rows were all written from a Stripe payment.
-- 2) `commission_events` is what the owner owes: $1 per client, per month, for
--    as long as that client pays. The unique (rep, client, period) key is the
--    guarantee that a replayed webhook cannot pay a rep twice for one month.
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS rep_user_id UUID REFERENCES users(id);
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'payment';

CREATE INDEX IF NOT EXISTS idx_referrals_rep_user ON referrals(rep_user_id);

CREATE TABLE IF NOT EXISTS commission_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_user_id UUID NOT NULL REFERENCES users(id),
  client_user_id UUID NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 100,
  source_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_out_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS commission_events_rep_client_period_idx
  ON commission_events (rep_user_id, client_user_id, period);

CREATE INDEX IF NOT EXISTS idx_commission_events_rep_unpaid
  ON commission_events (rep_user_id, paid_out_at);
