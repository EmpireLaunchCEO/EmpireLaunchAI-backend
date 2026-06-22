import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to support token-based authentication for mobile clients.
 * In a production environment, this would verify a JWT or an opaque session token.
 */
export const mobileAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];

  // Beta User ID for testing
  const BETA_USER_ID = '00000000-0000-0000-0000-000000000000';

  // Mock verification logic
  if (token === 'mock-mobile-token' || token.length > 10) {
    // Inject user info into request object for controllers
    const userIdFromHeader = req.headers['x-user-id'] as string;
    const finalUserId = userIdFromHeader || BETA_USER_ID;

    (req as any).userId = finalUserId;
    (req as any).user = { id: finalUserId };
    
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid token' });
};
