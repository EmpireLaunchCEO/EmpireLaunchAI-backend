import { Request, Response, NextFunction } from 'express';

const FAILED_ATTEMPTS_PREFIX = 'auth:failed:';
const LOCKOUT_PREFIX = 'auth:lockout:';

export async function authBruteForceProtection(req: Request, res: Response, next: NextFunction) {
  /*
  const ip = req.ip;
  const lockoutKey = `${LOCKOUT_PREFIX}${ip}`;
  
  const isLocked = await redisConnection.get(lockoutKey);
  if (isLocked) {
    return res.status(429).json({ 
      error: 'Too many failed attempts. Please try again later.',
      retryAfter: await redisConnection.ttl(lockoutKey)
    });
  }
  */
  
  next();
}

export async function recordFailedAttempt(ip: string) {
  /*
  const attemptsKey = `${FAILED_ATTEMPTS_PREFIX}${ip}`;
  const attempts = await redisConnection.incr(attemptsKey);
  
  if (attempts === 1) {
    await redisConnection.expire(attemptsKey, 3600); // Reset counter after 1 hour
  }
  
  if (attempts >= 5) {
    const lockoutKey = `${LOCKOUT_PREFIX}${ip}`;
    // Exponential delay: 5th attempt = 30s, 6th = 60s, 7th = 120s, etc.
    const delay = Math.pow(2, attempts - 5) * 30;
    await redisConnection.setex(lockoutKey, delay, 'true');
    console.warn(`[SECURITY] IP ${ip} locked out for ${delay} seconds due to brute force detection.`);
  }
  */
}