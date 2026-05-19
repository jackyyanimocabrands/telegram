import { Redis } from 'ioredis';
import { env } from '../config/env.js';

let _redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, { lazyConnect: true });
  }
  return _redis;
}
