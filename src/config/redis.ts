import { Redis } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// @ts-ignore
export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

redisConnection.on('error', (err: any) => {
  console.error('Redis Connection Error:', err);
});

redisConnection.on('connect', () => {
  console.log('Successfully connected to Redis');
});
