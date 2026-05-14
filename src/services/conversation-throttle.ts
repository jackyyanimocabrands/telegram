import type Redis from 'ioredis';
import { getRedisClient } from './redis.js';
import { logger } from '../utils/logger.js';

export interface ThrottleResult {
  allowed: boolean;
  retryAfterMs: number; // 0 when allowed
}

export async function checkManagerThrottle(
  userId: number,
  windowMs: number,
  redisClient: Redis = getRedisClient(),
): Promise<ThrottleResult> {
  const key = `throttle:manager:${userId}`;
  logger.debug({ userId , windowMs}, 'checkManagerThrottle: checking throttle');
  const result = await redisClient.set(key, '1', 'PX', windowMs, 'NX');

  if (result === 'OK') {
    return { allowed: true, retryAfterMs: 0 };
  }

  const pttl = await redisClient.pttl(key);
  const retryAfterMs = pttl > 0 ? pttl : windowMs;

  logger.debug({ userId, retryAfterMs }, 'checkManagerThrottle: throttled');
  return { allowed: false, retryAfterMs };
}
