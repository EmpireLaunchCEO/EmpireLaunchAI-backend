import { Request, Response, NextFunction } from 'express';
import { authRequiredBody } from './mobileAuth.js';

/**
 * Logical Multi-Tenant Isolation Middleware
 *
 * Ensures that every request has a verified user context and scopes all
 * subsequent operations to that specific user (tenant).
 *
 * Identity comes from the session that `mobileAuth` (or the router) verified —
 * never from a header the caller can type. `x-user-id` used to be read here,
 * which made "change one header, become another account" possible.
 */
export function tenantIsolation(req: Request, res: Response, next: NextFunction) {
  const userId = (req as any).userId as string | undefined;

  if (!userId) {
    return res.status(401).json(authRequiredBody());
  }

  // Set a logical "Security Boundary" for the request
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  next();
}

/**
 * Usage in Controllers:
 * const businesses = await db.select().from(businessesTable).where(eq(businessesTable.userId, req.userId));
 */
