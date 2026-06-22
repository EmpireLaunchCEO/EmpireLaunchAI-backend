# Empire Launch AI — Final Deployment Manifest

> **Owner:** Staci Peabody (`stacipeabody@gmail.com`)
> **Product:** EmpireLaunch AI — Autonomous Business Builder Platform
> **Target Platform:** Vercel (Serverless + Edge Functions)
> **Status:** ✅ **READY FOR OWNER FINAL REVIEW**
> **Stripe:** ✅ **Confirmed Set Up by Owner**

---

## 1. Vercel Deployment Configuration

### Backend (API + Workers)
- **Repository:** `EmpireLaunchCEO/EmpireLaunchAI-backend`
- **GitHub:** `github.com/EmpireLaunchCEO/EmpireLaunchAI-backend`
- **Framework:** Node.js 20+ (Express + TypeScript)
- **Build Command:** `npx tsc && cp -r node_modules dist/`
- **Output Dir:** `dist/`
- **Serverless Entry:** `api/index.ts`
- **Config File:** `vercel.json` (rewrites all routes to `api/index.ts`)

### Frontend (Next.js PWA)
- **Repository:** `EmpireLaunchCEO/EmpireLaunchAI-frontend`
- **GitHub:** `github.com/EmpireLaunchCEO/EmpireLaunchAI-frontend`
- **Framework:** Next.js (with Framer Motion + Tailwind CSS)
- **Build Command:** `npm run build && echo $(date) > build_timestamp.txt`
- **Output Dir:** `.next`
- **Config File:** `vercel.json` (framework: nextjs)

### Vercel Permanent Link Logic
Both repositories are pre-configured with `vercel.json` files. The deployment flow is:

1. **Owner provides Vercel target URL** (e.g., via Vercel dashboard import from GitHub)
2. **Import repositories** into Vercel — connect `EmpireLaunchCEO/EmpireLaunchAI-backend` and `EmpireLaunchCEO/EmpireLaunchAI-frontend`
3. **Set environment variables** (see Section 2 below)
4. **Deploy** — Vercel automatically builds and serves both
5. **Result** — A permanent link is generated: `https://empirelaunch-ai.vercel.app` (or custom domain)

> ⬜ **Action needed:** Owner to confirm the actual Vercel deployment URL once repositories are imported and first deploy completes.

---

## 2. Environment Variables Checklist

### Core Infrastructure (Required)
- [ ] `PORT` — Backend port (default: `3001`)
- [ ] `DATABASE_URL` — Turso/libSQL connection string (e.g., `libsql://your-db.turso.io`)
- [ ] `DATABASE_AUTH_TOKEN` — Turso authentication token
- [ ] `ENCRYPTION_KEY` — 32-byte hex key for AES-256-GCM credential encryption
- [ ] `HMAC_SALT` — Salt for PII-blind transaction hashing
- [ ] `NODE_ENV` — `production` for live deployment

### AI & Intelligence (Required)
- [ ] `OPENAI_API_KEY` — For Style DNA synthesis, Design Reasoner, Conversational Consultant
- [ ] `GEMINI_API_KEY` — For Gemini 3 Flash Intelligence Layer (optional, fallback)

### Social Platform Integrations (OAuth)
- [ ] `ETSY_CLIENT_ID` / `ETSY_CLIENT_SECRET`
- [ ] `META_CLIENT_ID` / `META_CLIENT_SECRET` — Instagram/Facebook
- [ ] `TIKTOK_CLIENT_ID` / `TIKTOK_CLIENT_SECRET`
- [ ] `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` — Google Cloud
- [ ] `GITHUB_TOKEN` — For agent code commits (if enabled)

### Payments & Billing — ✅ CONFIRMED SET UP BY OWNER
- [x] `STRIPE_SECRET_KEY` — Stripe private key
- [x] `STRIPE_PUBLISHABLE_KEY` — Stripe public key
- [x] `STRIPE_WEBHOOK_SECRET` — Webhook signature verification
- [x] `STRIPE_CONNECT_CLIENT_ID` — For Stripe Connect (bank payouts to seller)

### App Configuration
- [ ] `FRONTEND_URL` — URL of the deployed frontend (e.g., `https://empirelaunch.vercel.app`)
- [ ] `BACKEND_URL` — URL of the deployed backend (e.g., `https://empirelaunch-api.vercel.app`)

---

## 3. Database Migration Status

| Table | Status | Notes |
|-------|--------|-------|
| `users` | ✅ Migrated | Auth + tier management |
| `dna_strands` | ✅ Created | Universal DNA Vault (500k+ capacity) |
| `style_previews` | 🟡 Pending | AI-synthesized preview storage (Phase 1 frontend) |
| `originality_registry` | ✅ Created | Anti-copycat dHash + CLIP storage |
| `ownership_vault` | ✅ Created | Encrypted API keys + tokens (AES-256-GCM) |
| `campaigns` | ✅ Created | Campaign management |
| `scheduled_posts` | ✅ Created | Multi-platform scheduling |
| `approvals` | ✅ Created | Human-in-the-Loop approval gates |
| `goals` | ✅ Created | Business goals orchestration |
| `integrations` | ✅ Created | Platform OAuth connections |
| `products` | ✅ Created | Stripe payment products |
| `payment_buttons` | ✅ Created | Social commerce payment bridges |
| `revenue_milestones` | ✅ Created | Success fee tracking |
| `audit_logs` | ✅ Created | Immutable security audit trail |

**Migration Command:** `cd backend && npx drizzle-kit push`

---

## 4. Infrastructure Requirements

### Runtime
- **Node.js:** >= 20.x (required for TypeScript 6 + ES modules)
- **Memory:** >= 512 MB (for Sharp image processing + AI model calls)
- **Timeout:** >= 30s (for AI generation endpoints)
- **Edge Functions:** Not required (serverless functions sufficient)

### Storage
- **Database:** Turso (libSQL) or Neon (Vercel Postgres) — Free tiers available
- **File Storage:** None required (DNA manifests stored in DB; previews generated on-demand)
- **Image Processing:** Sharp (included in dependencies)

### External Services
- **OpenAI API:** Required for Style DNA synthesis, Design Reasoning, Conversational Consultant
- **Stripe:** ✅ OWNER CONFIRMED — Payment processing & Connect payouts
- **Canva API:** Optional (for Tier 1 style preview generation)
- **Etsy API:** Required for listing creation
- **Meta API:** Required for Instagram/Facebook posting

---

## 5. Health Check Endpoints

Once deployed, verify these endpoints:

```
GET /health
→ { "status": "ok", "scale": "ready" }

GET /api/vault/stats
→ DNA Vault statistics (strand count, storage budget)

GET /api/studio/assets
→ User assets (requires auth)

POST /api/studio/chat
→ Conversational Consultant (requires auth + body)
```

---

## 6. Key Features Ready for Owner Review

### ✅ Complete
- **Universal DNA Vault** — 500k+ strand capacity, similarity search, performance weighting
- **Visual Proxy Service** — Zero-Source-Image AI-synthesized previews from DNA
- **DNA Hunt Pipeline** — Automated style extraction from connected platforms
- **Empire Studio** — Multi-platform creation & distribution pipeline
- **Anti-Copycat Engine** — 3-tier validation (dHash + CLIP + Zero-Source-Image)
- **Human-in-the-Loop Approval Gates** — Every action requires user sign-off
- **Conversational Consultant** — AI chat with visual style suggestions (backend ready)
- **App Store Metadata** — Full ASO-optimized listing for Apple App Store & Google Play
- **Stripe Payments** — ✅ Owner confirmed setup complete

### 🟡 In Progress (Frontend Visual UI)
- **Visual Style Picker** — Abstract style cards showing AI-synthesized previews
- **Style Picker Gallery** — Grid of style cards with vibe filters
- **Inspiration Gallery UI** — Frontend component for browsing styles

---

## 7. Owner Handover Summary

### Owner Contact
- **Email:** ✅ `stacipeabody@gmail.com`
- **Product:** EmpireLaunch AI (App Store: "EmpireLaunch: Biz Builder")
- **Core Value Prop:** "AI builds, launches, and grows your online business while you stay in control"

### Infrastructure Account Logins (Owner's Records)

| Service | Account | Tier |
|---------|---------|------|
| **GitHub** | `EmpireLaunchCEO` | Free |
| **Vercel** | Connected via GitHub | Hobby (Free) |
| **OpenAI** | Owner's email | Pay-as-you-go |
| **Stripe** | ✅ Confirmed Set Up | Standard Connect |
| **Neon (DB)** | Linked via Vercel | Free |
| **Etsy Dev** | Owner's developer app | Free |
| **Meta Dev** | Owner's developer app | Free |

### What Remains to Be Done by Owner
1. ⬜ Provide OpenAI API key (add to Vercel env vars)
2. ⬜ Provide Etsy Developer App credentials
3. ⬜ Provide Meta Developer App credentials (Instagram/Facebook)
4. ⬜ Confirm Vercel deployment URL after first deploy
5. ⬜ Set custom domain (optional)

### Post-Deployment Checklist
1. [ ] Verify `/health` responds with `{ "status": "ok" }`
2. [ ] Run `POST /api/vault/seed` to populate DNA Vault with premium archetypes
3. [ ] Create a test goal via the dashboard
4. [ ] Verify conversational consultant responds
5. [ ] Run anti-copycat validation on a generated design
6. [ ] Test Stripe payment link creation
7. [ ] Test Etsy draft listing creation

---

## 8. Troubleshooting

| Issue | Likely Cause | Fix |
|-------|-------------|------|
| `DATABASE_URL` error | Turso/Neon credentials not set | Verify DB URL + auth token in Vercel env vars |
| Timeout on AI endpoints | OpenAI API key missing | Set `OPENAI_API_KEY` env var |
| OAuth callback fails | `FRONTEND_URL` mismatch | Set correct frontend URL in env vars |
| Style previews not showing | Missing `synthesisPrompt` handler | Check `dna-visual-snapshots` WebSocket event |
| Stripe Connect fails | Stripe env vars not set | Confirm `STRIPE_SECRET_KEY` etc. are in Vercel |

---

*Generated for Staci Peabody (`stacipeabody@gmail.com`) — EmpireLaunch AI Autonomous Business Builder Platform*
*Last updated: 2026-06-04 | Status: ✅ Ready for Owner Final Review*