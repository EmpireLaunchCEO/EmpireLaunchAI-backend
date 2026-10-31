import { Request, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isOwnerIdentity } from '../services/ownerIdentity.js';
import { getOwnerBillingStats } from '../services/stripeSubscriptions.js';

const { users, subscriptions, goals } = schema;

/**
 * GET /api/admin/client-stats — owner-only business numbers for Home Base.
 *
 * Response (the first two keys are unchanged so the existing Home Base card keeps
 * working; everything below them is new):
 *
 *   {
 *     activeSubscribers: number | null,
 *     totalClients: number | null,
 *     activeSubscribersSource: 'stripe' | 'db',
 *     payingClients: { total, subscription, brand2, brand3 } | null,
 *     cancellingClients: number | null,
 *     billingReadAt: string | null,
 *     billingError: string | null,
 *   }
 *
 * Definitions:
 *   payingClients     = distinct clients with at least one LIVE Stripe subscription
 *                       (status active/trialing/past_due), owner excluded. A client
 *                       who cancelled but is still inside a paid period still counts
 *                       — they are still paying for, and using, the platform.
 *   …ByBrand          = the same count per brand slot. A client holding the base
 *                       subscription plus Brand 2 appears in both, so the per-brand
 *                       numbers are not required to sum to `total`.
 *   cancellingClients = distinct clients whose subscription has
 *                       `cancel_at_period_end` set but has not ended yet (the
 *                       separate "Cancellations" box; no dates there, per owner).
 *   activeSubscribers = the Stripe `payingClients.total` when Stripe answers —
 *                       Stripe is the only place a real payment is recorded. The
 *                       old DB count (`subscriptions` rows with canceled_at null)
 *                       is used only when Stripe cannot be read, and
 *                       `activeSubscribersSource` says which one was used.
 *   totalClients      = distinct users who own at least one empire (`goals` row),
 *                       i.e. users who actually signed up and completed empire
 *                       creation. The `users` table is NOT the right source: the
 *                       session middleware auto-provisions a `users` row for every
 *                       anonymous caller, so counting users would report hundreds
 *                       of drive-by placeholder accounts as "clients".
 *
 * Owner exclusion runs in JS through services/ownerIdentity.ts (the same rule the
 * quota layer uses) rather than in SQL, because Gmail dot/alias variants cannot be
 * expressed portably in one predicate across the Postgres/LibSQL backends this
 * repo supports. Both source tables are small, so the full read is cheap and the
 * rule cannot drift from the rest of the app.
 *
 * Never returns a placeholder: a failure is `null` (so the card shows "—") or a
 * 500 — never a fake 0 that reads as "nobody is paying".
 */
export async function getClientStats(_req: Request, res: Response) {
  // ── Stripe: the real money ────────────────────────────────────────────────
  let billing: Awaited<ReturnType<typeof getOwnerBillingStats>> | null = null;
  let billingError: string | null = null;
  try {
    billing = await getOwnerBillingStats();
  } catch (error: any) {
    billingError = error?.message || 'Stripe read failed';
    console.error('[adminController] client-stats billing read failed:', billingError);
  }

  // ── DB: who signed up (unaffected by billing outages) ─────────────────────
  // The two reads are independent: on the LibSQL/LibSQL-schema build `subscriptions`
  // is not in the schema at all, and a missing table must not also lose the client
  // count (that used to take the whole endpoint down with a TypeError).
  let dbActiveSubscribers: number | null = null;
  try {
    const subscriptionRows = await db
      .select({ userId: subscriptions.userId, id: users.id, email: users.email, tier: users.tier })
      .from(subscriptions)
      .innerJoin(users, eq(users.id, subscriptions.userId))
      .where(and(isNull(subscriptions.canceledAt), eq(subscriptions.type, 'subscription')));

    const activeSubscribers = new Set<string>();
    for (const row of subscriptionRows) {
      if (!isOwnerIdentity(row)) activeSubscribers.add(row.userId);
    }
    dbActiveSubscribers = activeSubscribers.size;
  } catch (error) {
    console.error('[adminController] client-stats subscription rows failed:', error);
  }

  let totalClients: number | null = null;
  try {
    const clientRows = await db
      .select({ userId: goals.userId, id: users.id, email: users.email, tier: users.tier })
      .from(goals)
      .innerJoin(users, eq(users.id, goals.userId));

    const clients = new Set<string>();
    for (const row of clientRows) {
      if (!isOwnerIdentity(row)) clients.add(row.userId);
    }
    totalClients = clients.size;
  } catch (error) {
    console.error('[adminController] client-stats client rows failed:', error);
  }

  // Neither source answered — an honest error, not zeros.
  if (!billing && totalClients === null) {
    return res.status(500).json({ error: 'Failed to read client stats' });
  }

  const activeSubscribers = billing ? billing.payingClients : dbActiveSubscribers;

  return res.json({
    activeSubscribers,
    totalClients,
    activeSubscribersSource: billing ? 'stripe' : 'db',
    payingClients: billing
      ? {
          total: billing.payingClients,
          subscription: billing.payingClientsByBrand.subscription,
          brand2: billing.payingClientsByBrand.brand2,
          brand3: billing.payingClientsByBrand.brand3,
        }
      : null,
    cancellingClients: billing ? billing.cancellingClients : null,
    billingReadAt: billing ? billing.readAt : null,
    billingError,
  });
}
