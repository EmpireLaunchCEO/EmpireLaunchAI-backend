-- Migration 0010: Add customer_name column to subscriptions table
-- Captures the customer's name from Stripe checkout sessions for dashboard display.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS customer_name TEXT;
