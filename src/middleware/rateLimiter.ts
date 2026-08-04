import { rateLimit } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redisConnection, isRedisDisabled } from "../config/redis.js";

let storeCounter = 0;
function createRedisStore(prefix: string): any | undefined {
  if (isRedisDisabled) return undefined;
  try {
    const store = new RedisStore({
      // @ts-ignore
      sendCommand: (...args: string[]) => redisConnection.call(...args),
      prefix: `rl:${prefix}:${++storeCounter}:`,
    });
    return store;
  } catch {
    console.warn("[RateLimiter] Redis store creation failed, using in-memory store");
    return undefined;
  }
}

const keyGen = (req: any): string => {
  const auth = req.headers?.authorization;
  if (auth?.startsWith("Bearer ")) return `user:${auth.slice(7)}`;
  return req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
};

export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  store: createRedisStore("global"),
  keyGenerator: keyGen,
  skip: (req: any) => req.method === "OPTIONS",
});

export const aiActionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 100,
  message: "Too many AI requests, please try again later",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  store: createRedisStore("ai"),
  keyGenerator: keyGen,
});
