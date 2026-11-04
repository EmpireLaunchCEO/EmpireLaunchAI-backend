import { Request, Response, NextFunction } from 'express';
import { db, schema } from '../db/index.js';
import { eq, and, gt } from 'drizzle-orm';
import { isOwnerIdentity } from '../services/ownerIdentity.js';

const { users } = schema;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Owner-only gate for business-wide numbers (e.g. GET /api/admin/client-stats).
 *
 * Identity is resolved exactly the way the rest of the app resolves it:
 *   1. a real Bearer session token (users.mobile_session_token, unexpired), else
 *   2. the `x-user-id` header the frontend sends alongside its token.
 * That identity is then checked against the single owner rule in
 * services/ownerIdentity.ts (seeded zero-UUID / owner email / OWNER_MASTER tier).
 *
 * Deliberately does NOT use mobileAuth: mobileAuth auto-provisions a user row for
 * any anonymous caller, which is fine for client routes but must never happen on
 * an admin route. No identity, unknown identity, or non-owner identity all get a
 * bare 403 — the response carries no counts and no hint about what exists.
 */
export async function requireOwner(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    let user: { id: string; email: string | null; tier: string | null } | undefined;

    // 1. Real session token
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim();
      if (token) {
        const [byToken] = await db.select({ id: users.id, email: users.email, tier: users.tier })
          .from(users)
          .where(and(eq(users.mobileSessionToken, token), gt(users.mobileSessionExpiresAt, new Date())))
          .limit(1);
        if (byToken) user = byToken;
      }
    }

    // 2. Fall back to the app's x-user-id identity convention
    if (!user) {
      const userIdHeader = req.headers['x-user-id'];
      const userId = typeof userIdHeader === 'string' ? userIdHeader.trim() : '';
      if (UUID_REGEX.test(userId)) {
        const [byId] = await db.select({ id: users.id, email: users.email, tier: users.tier })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (byId) user = byId;
      }
    }

    if (!user || !isOwnerIdentity(user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    (req as any).ownerUser = user;
    return next();
  } catch (error) {
    // A DB failure must not be reported as "0 subscribers" — surface it as an
    // error and let the client render its unknown state.
    console.error('[requireOwner] identity lookup failed:', error);
    return res.status(503).json({ error: 'Owner check unavailable' });
  }
}
