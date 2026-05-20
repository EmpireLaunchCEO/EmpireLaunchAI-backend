import { Request, Response, NextFunction } from 'express';

/**
 * Logical Multi-Tenant Isolation Middleware
 * 
 * Ensures that every request has a valid user context and scopes 
 * all subsequent operations to that specific user (tenant).
 */
export function tenantIsolation(req: Request, res: Response, next: NextFunction) {
  // In a real app, this would be extracted from a verified JWT
  const userId = req.headers['x-user-id'] as string;

  if (!userId) {
    return res.status(401).json({ 
      error: 'Unauthorized', 
      message: 'No user context provided. Security policy requires a valid tenant ID.' 
    });
  }

  // Attach the user ID to the request object for use in controllers/services
  (req as any).userId = userId;
  
  // Set a logical "Security Boundary" for the request
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  
  next();
}

/**
 * Usage in Controllers:
 * const businesses = await db.select().from(businessesTable).where(eq(businessesTable.userId, req.userId));
 */
