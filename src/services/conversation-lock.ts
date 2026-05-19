import type { Redis } from 'ioredis';
import { getRedisClient } from './redis.js';
import { logger } from '../utils/logger.js';

const LOCK_KEY_PREFIX = 'lock';

function lockKey(conversationId: string): string {
  return `${LOCK_KEY_PREFIX}:${conversationId}`;
}

/**
 * Attempt to acquire a processing lock for a conversation.
 * Returns true if acquired, false if already held.
 */
export async function acquireLock(
  conversationId: string,
  ttlSecs: number,
  redisClient: Redis = getRedisClient(),
): Promise<boolean> {
  const result = await redisClient.set(lockKey(conversationId), '1', 'EX', ttlSecs, 'NX');
  return result === 'OK';
}

/**
 * Release the processing lock for a conversation.
 */
export async function releaseLock(
  conversationId: string,
  redisClient: Redis = getRedisClient(),
): Promise<void> {
  await redisClient.del(lockKey(conversationId));
  logger.debug({ conversationId }, 'releaseLock: released');
}
