-- Migration: Add stripeSubscriptionId to subscriptions table for Stripe cancel support
-- Date: 2026-07-25
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
