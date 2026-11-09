-- Migration 0014: Stripe payment webhook ledger
--
-- The app has never learned that a client paid: the owner's Stripe Payment Links
-- take the money in HER account and nothing told us. `POST /api/webhooks/stripe`
-- now applies each `checkout.session.completed` to the existing subscriptions /
-- subscription_logs / users.business_slots model.
--
-- This table is (a) the idempotency ledger — `id` is the Stripe event id, so a
-- retried delivery conflicts and is answered 200 without paying twice — and
-- (b) the home of a real payment we could not attribute to a user
-- (`status = 'unmatched'`). A payment is never dropped on the floor.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  user_id UUID,
  brand_slot INTEGER,
  payment_link_id TEXT,
  stripe_session_id TEXT,
  stripe_customer_id TEXT,
  customer_email TEXT,
  amount_total INTEGER,
  currency TEXT,
  mode TEXT,
  payload JSONB,
  received_at TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_status_idx
  ON stripe_webhook_events (status);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_session_idx
  ON stripe_webhook_events (stripe_session_id);
