import type { Redis } from 'ioredis';
import { getRedisClient } from './redis.js';
import { logger } from '../utils/logger.js';

const THROTTLE_KEY_PREFIX = 'throttle';

export interface ThrottleResult {
  allowed: boolean;
  retryAfterMs: number; // 0 when allowed
}

function throttleKey(conversationId: string): string {
  return `${THROTTLE_KEY_PREFIX}:${conversationId}`;
}

/**
 * Atomically set the throttle key for a conversation.
 * Returns allowed=true if the key was set (i.e. no active throttle).
 * Returns allowed=false with retryAfterMs if throttle is active.
 * windowMs=0 always returns allowed=true without touching Redis.
 */
export async function checkThrottle(
  conversationId: string,
  windowMs: number,
  redisClient: Redis = getRedisClient(),
): Promise<ThrottleResult> {
  if (windowMs === 0) {
    return { allowed: true, retryAfterMs: 0 };
  }

  const key = throttleKey(conversationId);
  logger.debug({ conversationId, windowMs }, 'checkThrottle: checking');
  const result = await redisClient.set(key, '1', 'PX', windowMs, 'NX');

  if (result === 'OK') {
    return { allowed: true, retryAfterMs: 0 };
  }

  const pttl = await redisClient.pttl(key);
  const retryAfterMs = pttl > 0 ? pttl : windowMs;

  logger.debug({ conversationId, retryAfterMs }, 'checkThrottle: throttled');
  return { allowed: false, retryAfterMs };
}
