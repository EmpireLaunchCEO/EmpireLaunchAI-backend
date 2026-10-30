import { Request, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isOwnerIdentity } from '../services/ownerIdentity.js';

const { users, subscriptions, goals } = schema;

/**
 * GET /api/admin/client-stats — owner-only business numbers for Home Base.
 *
 * Returns exactly:
 *   { activeSubscribers: number, totalClients: number }
 *
 * Definitions (both exclude the owner — she is never a client of her own product):
 *   activeSubscribers = distinct users holding a `subscriptions` row with
 *                       type = 'subscription' and canceled_at IS NULL.
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
 * Never returns a placeholder: a query failure is a 500, not zeros.
 */
export async function getClientStats(_req: Request, res: Response) {
  try {
    const subscriptionRows = await db
      .select({ userId: subscriptions.userId, id: users.id, email: users.email, tier: users.tier })
      .from(subscriptions)
      .innerJoin(users, eq(users.id, subscriptions.userId))
      .where(and(isNull(subscriptions.canceledAt), eq(subscriptions.type, 'subscription')));

    const clientRows = await db
      .select({ userId: goals.userId, id: users.id, email: users.email, tier: users.tier })
      .from(goals)
      .innerJoin(users, eq(users.id, goals.userId));

    const activeSubscribers = new Set<string>();
    for (const row of subscriptionRows) {
      if (!isOwnerIdentity(row)) activeSubscribers.add(row.userId);
    }

    const totalClients = new Set<string>();
    for (const row of clientRows) {
      if (!isOwnerIdentity(row)) totalClients.add(row.userId);
    }

    return res.json({
      activeSubscribers: activeSubscribers.size,
      totalClients: totalClients.size,
    });
  } catch (error) {
    console.error('[adminController] client-stats failed:', error);
    return res.status(500).json({ error: 'Failed to read client stats' });
  }
}
