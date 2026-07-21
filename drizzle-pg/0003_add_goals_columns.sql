ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "archetype" text DEFAULT 'SELLER' NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "target_customers" text;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "business_goals" text;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "approval_required" boolean DEFAULT true NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "auto_post" boolean DEFAULT false NOT NULL;