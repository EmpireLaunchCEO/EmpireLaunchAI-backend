import { Redis } from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

const isRedisDisabled = process.env.NO_REDIS === 'true';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let redisConnection: any;

if (isRedisDisabled) {
  console.log('Redis disabled via NO_REDIS');
  redisConnection = {
    on: () => {},
    defineCommand: () => {},
    options: {},
    call: () => Promise.resolve(),
  };
} else {
  // @ts-ignore
  redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  redisConnection.on('error', (err: any) => {
    console.error('Redis Connection Error:', err);
  });
  redisConnection.on('connect', () => {
    console.log('Successfully connected to Redis');
  });
}

export { redisConnection, isRedisDisabled };
