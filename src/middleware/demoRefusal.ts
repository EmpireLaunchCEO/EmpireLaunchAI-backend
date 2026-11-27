/**
 * DEMO ACCOUNTS NEVER SPEND (owner, Nov 27).
 *
 * A demo account exists to show the product. It uses sample data only and must
 * never reach a provider, so the refusal happens in middleware — BEFORE any
 * controller builds a provider client, buys motion, or spends quota.
 *
 * It runs after `mobileAuth` (which is what puts the real user row, and so the
 * real role, on the request). It reads `req.user.role` and nothing the caller
 * can type: a demo session cannot become a client by sending a header.
 *
 * The message says what the account is, in plain words, and never mentions
 * money — the same rule every client-facing sentence follows.
 */
import { Request, Response, NextFunction } from 'express';
import { isDemoUser } from '../services/repTracking.js';

export const DEMO_REFUSAL_MESSAGE =
  "This is a demo account — it shows how the app works and doesn't make videos.";

export const DEMO_REFUSAL_CODE = 'DEMO_ACCOUNT';

/** 403 for a demo session, `next()` for everybody else. */
export function denyDemo(req: Request, res: Response, next: NextFunction) {
  if (isDemoUser((req as any).user)) {
    return res.status(403).json({ error: DEMO_REFUSAL_MESSAGE, code: DEMO_REFUSAL_CODE });
  }
  return next();
}
