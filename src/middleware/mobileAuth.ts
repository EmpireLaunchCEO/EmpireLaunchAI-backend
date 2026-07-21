import { Request, Response, NextFunction } from 'express';
import { db, schema } from '../db/index.js';
import { eq, and, gt } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/**
 * Middleware for real token-based authentication.
 * Auto-creates sessions for trusted users so no mock tokens are ever needed.
 */
export const mobileAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const userIdFromHeader = req.headers['x-user-id'] as string;
  const { users } = schema;

  const BETA_USER_ID = '00000000-0000-0000-0000-000000000000';
  const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  // If a token is provided, look it up in the database
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];

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

    // Token was provided but invalid/expired
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
  }

  // No token provided — auto-create a session for the beta user
  const finalUserId = userIdFromHeader || BETA_USER_ID;
  const newToken = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  try {
    // Check if user exists
    const [existingUser] = await db.select().from(users).where(eq(users.id, finalUserId)).limit(1);

    if (existingUser) {
      // Update with new session token
      await db.update(users)
        .set({
          mobileSessionToken: newToken,
          mobileSessionExpiresAt: expiresAt,
          updatedAt: new Date()
        })
        .where(eq(users.id, finalUserId));
    } else {
      // Create user with session
      await db.insert(users).values({
        id: finalUserId,
        mobileSessionToken: newToken,
        mobileSessionExpiresAt: expiresAt,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    // Return the new token in the response header so the frontend can store it
    res.setHeader('X-Session-Token', newToken);
    res.setHeader('X-Session-Expires', expiresAt.toISOString());

    (req as any).userId = finalUserId;
    (req as any).user = { id: finalUserId, mobileSessionToken: newToken };
    return next();
  } catch (err) {
    console.error('[mobileAuth] Session creation error:', err);
    return res.status(500).json({ error: 'Failed to create session' });
  }
};
