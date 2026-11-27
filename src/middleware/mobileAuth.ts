/**
 * REAL AUTHENTICATION (owner, Nov 27: "fix authentication first").
 *
 * WHAT THIS USED TO DO — and why it was the root privacy defect:
 *   - a Bearer token that matched no session FELL THROUGH to an auto-provision
 *     branch that created a user row for `x-user-id` (or a random UUID) and
 *     minted a session, so an unauthenticated caller was logged in as whatever
 *     user id they typed;
 *   - `x-user-id` on its own was accepted as identity.
 *
 * WHAT IT DOES NOW:
 *   - a valid, unexpired session token → `req.userId`, `req.user`, `next()`;
 *   - EVERYTHING else — no header, a malformed header, an unknown token, an
 *     expired token, a token that is really a user id, `x-user-id` on its own —
 *     → `401 { error: 'AUTH_REQUIRED' }`.
 *
 * It never creates a user. A request can never turn itself into an account.
 */
import { Request, Response, NextFunction } from 'express';
import { findSession, sessionTokenFromRequest } from '../services/authSessions.js';

/** The one refusal body. Nothing about the caller, nothing about what exists. */
export function authRequiredBody(): { error: string } {
  return { error: 'AUTH_REQUIRED' };
}

export const mobileAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = sessionTokenFromRequest(req);
  if (!token) return res.status(401).json(authRequiredBody());

  try {
    const session = await findSession(token);
    if (!session) return res.status(401).json(authRequiredBody());

    (req as any).userId = session.userId;
    (req as any).user = session.user;
    return next();
  } catch (err) {
    // A database outage is not a credential problem: answering 401 here would
    // silently sign every client out. Say the check is unavailable instead.
    console.error('[mobileAuth] session lookup failed:', (err as Error)?.message || err);
    return res.status(503).json({ error: 'AUTH_UNAVAILABLE' });
  }
};
