-- Migration 0017: referral codes
--
-- A rep gets their own link (/join/<CODE>). The code is derived from the rep's
-- own name, uppercased and URL-safe, and unique across all reps.
CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  rep_user_id UUID NOT NULL REFERENCES users(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_rep ON referral_codes(rep_user_id);
