import { Request, Response, NextFunction } from 'express';
import { db, schema } from '../db/index.js';
import { eq, and, gt } from 'drizzle-orm';

/**
 * Middleware to support token-based authentication for mobile clients.
 * Supports both mock tokens for development and persisted mobile sessions.
 */
export const mobileAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const { users } = schema;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];

  // Beta User ID for testing
  const BETA_USER_ID = '00000000-0000-0000-0000-000000000000';

  // 1. Development/Beta Bypass
  if (token === 'mock-mobile-token') {
    const userIdFromHeader = req.headers['x-user-id'] as string;
    const finalUserId = userIdFromHeader || BETA_USER_ID;

    (req as any).userId = finalUserId;
    (req as any).user = { id: finalUserId };
    return next();
  }

  // 2. Persisted Mobile Session Check
  try {
    const [user] = await db.select()
      .from(users)
      .where(and(
        eq(users.mobileSessionToken, token),
        gt(users.mobileSessionExpiresAt, new Date())
      ))
      .limit(1);

    if (user) {
      (req as any).userId = user.id;
      (req as any).user = user;
      return next();
    }
  } catch (err) {
    console.error('[mobileAuth] Database error:', err);
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid or expired mobile session' });
};
