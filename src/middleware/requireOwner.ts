import { Request, Response, NextFunction } from 'express';
import { isOwnerIdentity } from '../services/ownerIdentity.js';
import { callerForRequest } from '../services/authSessions.js';

/**
 * Owner-only gate for business-wide numbers (e.g. GET /api/admin/client-stats).
 *
 * Identity is resolved exactly one way: a real Bearer session token (a row in
 * `auth_sessions`, unexpired) — the same rule `mobileAuth` applies. That user is
 * then checked against the single owner rule in services/ownerIdentity.ts
 * (seeded zero-UUID / owner email / OWNER_MASTER tier).
 *
 * The old `x-user-id` fallback is GONE: it let a caller become the owner by
 * typing the owner's id into a header.
 *
 * No identity, unknown identity, or non-owner identity all get a bare 403 — the
 * response carries no counts and no hint about what exists.
 */
export async function requireOwner(req: Request, res: Response, next: NextFunction) {
  try {
    const caller = await callerForRequest(req);

    if (!caller || !isOwnerIdentity(caller.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    (req as any).userId = caller.userId;
    (req as any).ownerUser = caller.user;
    return next();
  } catch (error) {
    // A DB failure must not be reported as "0 subscribers" — surface it as an
    // error and let the client render its unknown state.
    console.error('[requireOwner] identity lookup failed:', error);
    return res.status(503).json({ error: 'Owner check unavailable' });
  }
}
