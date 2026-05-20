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

  // Mock verification logic
  // In a real app: const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (token === 'mock-mobile-token' || token.length > 10) {
    // Inject mock user info if needed
    // req.user = { id: 'user-123' };
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid token' });
};
