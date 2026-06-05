import { Redis } from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const isRedisDisabled = process.env.NO_REDIS === 'true' || !process.env.REDIS_URL;
const redisUrl = process.env.REDIS_URL || '';
let redisConnection: any;

if (isRedisDisabled) {
  console.log('[Redis] Disabled (NO_REDIS=true or REDIS_URL not set). Using in-memory mock.');
  redisConnection = {
    on: () => redisConnection,
    off: () => redisConnection,
    defineCommand: () => {},
    options: {},
    call: () => Promise.resolve(),
    add: () => Promise.resolve('mock-job-id'),
    get: () => Promise.resolve(null),
    set: () => Promise.resolve('OK'),
    del: () => Promise.resolve(1),
    quit: () => Promise.resolve('OK'),
  };
} else {
  try {
    // @ts-ignore
    redisConnection = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      retryStrategy: (times: number) => {
        if (times > 3) {
          console.error('[Redis] Max retries reached. Disabling Redis.');
          return null; // Stop retrying, fail fast
        }
        return Math.min(times * 200, 2000);
      },
    });
    redisConnection.on('error', (err: any) => {
      console.error('[Redis] Connection Error:', err.message);
    });
    redisConnection.on('connect', () => {
      console.log('[Redis] Successfully connected');
    });
  } catch (err: any) {
    console.error('[Redis] Init failed, using in-memory mock:', err.message);
    redisConnection = {
      on: () => redisConnection,
      off: () => redisConnection,
      defineCommand: () => {},
      options: {},
      call: () => Promise.resolve(),
      add: () => Promise.resolve('mock-job-id'),
      get: () => Promise.resolve(null),
      set: () => Promise.resolve('OK'),
      del: () => Promise.resolve(1),
      quit: () => Promise.resolve('OK'),
    };
  }
}

export { redisConnection, isRedisDisabled };
