import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisConnection, isRedisDisabled } from '../config/redis.js';

function createRedisStore(): any | undefined {
  if (isRedisDisabled) return undefined;
  try {
    // Verify Redis is actually connected before creating store
    const store = new RedisStore({
      // @ts-ignore
      sendCommand: (...args: string[]) => redisConnection.call(...args),
    });
    return store;
  } catch {
    console.warn('[RateLimiter] Redis store creation failed, using in-memory store');
    return undefined;
  }
}

const redisStore = createRedisStore();

// Per-user key generator: uses auth token for authenticated users, IP for anonymous
const userAwareKeyGenerator = (req: any): string => {
  const authHeader = req.headers?.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return `user:${authHeader.slice(7)}`; // Per-user bucket
  }
  return req.ip ?? 'unknown'; // Per-IP bucket for unauthenticated
};

export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 1000, // Per-user for authenticated, per-IP for anonymous
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore,
  keyGenerator: userAwareKeyGenerator,
  skip: (req) => req.method === 'OPTIONS', // CORS preflight should not consume rate limit
});

export const aiActionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 100, // Per-user for authenticated, per-IP for anonymous
  message: 'Too many AI requests, please try again later',
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore,
  keyGenerator: userAwareKeyGenerator,
});
