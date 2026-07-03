CREATE TABLE IF NOT EXISTS audit_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  total_revenue INTEGER NOT NULL DEFAULT 0,
  ai_attributed_revenue INTEGER NOT NULL DEFAULT 0,
  success_share_due INTEGER NOT NULL DEFAULT 0,
  lifetime_surcharges_paid INTEGER NOT NULL DEFAULT 0,
  content_created INTEGER NOT NULL DEFAULT 0,
  active_campaigns INTEGER NOT NULL DEFAULT 0,
  milestone_hit INTEGER NOT NULL DEFAULT 0,
  generated_at TIMESTAMP NOT NULL DEFAULT NOW()
);