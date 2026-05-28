# Empire Deployment Manifest

This document outlines the required environment variables and infrastructure setup for the Permanent Link deployment of the BizRunner backend.

## Environment Variables

### Core Infrastructure
- `PORT`: Port the service listens on (default: `3000`).
- `DATABASE_URL`: Connection string (e.g., `libsql://your-turso-db.turso.io` or `file:bizrunner.db`).
- `DATABASE_AUTH_TOKEN`: Auth token for Turso/LibSQL.
- `ENCRYPTION_KEY`: 32-byte hex key for encrypting platform credentials in the `ownership_vault`.
- `HMAC_SALT`: Salt for hashing transaction IDs in the `transaction_hashes` table to ensure PII-blind aggregation.

### Authentication & API Integrations
- `OPENAI_API_KEY`: Required for Strategic Intellect (Reasoning Engine) and content generation.
- `GITHUB_TOKEN`: Required for the agent loop to commit and push code updates (if enabled).

#### Platform Integrations (OAuth)
- `ETSY_CLIENT_ID` / `ETSY_CLIENT_SECRET`: Etsy developer credentials.
- `META_CLIENT_ID` / `META_CLIENT_SECRET`: Meta developer credentials (Instagram/Facebook).
- `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`: Google Cloud console credentials.

### Payments & Billing
- `STRIPE_SECRET_KEY`: Private key for success fee withholding and subscription billing.
- `STRIPE_PUBLISHABLE_KEY`: Public key for frontend integration.
- `STRIPE_WEBHOOK_SECRET`: Secret to verify Stripe webhook signatures.

### App Configuration
- `FRONTEND_URL`: URL of the deployed frontend PWA for OAuth callbacks.

## Infrastructure Checklist
1. **Turso Database**: Ensure tables are migrated using `drizzle-kit push` or raw SQL from `sqlite-schema.ts`.
2. **Notification Service**: Verify Web Push / FCM tokens are correctly stored in the `push_subscriptions` table.
3. **Financial Enclave**: The `RevenueOracle` (ledger) should be deployed in a secure context where `ENCRYPTION_KEY` is protected.
4. **Agent Loops**: The `ExecutionPipelineService` requires access to the `agent-browser` capability in the runtime environment.
