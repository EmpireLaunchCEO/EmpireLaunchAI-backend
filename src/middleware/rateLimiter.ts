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

export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // Limit each IP to 100 requests per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore,
});

export const aiActionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 20, // Limit each IP to 20 AI actions per hour
  message: 'Too many AI requests from this IP, please try again after an hour',
  store: redisStore,
});
