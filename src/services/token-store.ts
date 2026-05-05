import { decrypt } from './encryption.js';
import * as managedBotQueries from '../db/queries/managed-bots.js';
import { logger } from '../utils/logger.js';

// M-03: In-memory TTL cache to avoid hitting the DB on every message.
interface CacheEntry {
  token: string;
  expiresAt: number;
}

export const tokenCache = new Map<number, CacheEntry>();
export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Invalidate a cached token entry. Call this whenever a bot's token is rotated.
 */
export function invalidateBotTokenCache(botId: number): void {
  tokenCache.delete(botId);
  logger.debug({ botId }, 'invalidateBotTokenCache: cache entry removed');
}

/**
 * Decrypt and return the bot token for a managed child bot.
 * Results are cached for 5 minutes to reduce DB load.
 * Shared between managed-bot.ts and child-bot.ts — avoids circular dependency.
 */
export async function getDecryptedBotToken(botId: number): Promise<string> {
  const now = Date.now();
  const cached = tokenCache.get(botId);
  if (cached && cached.expiresAt > now) {
    logger.debug({ botId }, 'getDecryptedBotToken: cache hit');
    return cached.token;
  }

  logger.debug({ botId }, 'getDecryptedBotToken: cache miss, looking up bot in DB');
  const bot = await managedBotQueries.findManagedBotByBotId(botId);
  if (!bot) {
    logger.warn({ botId }, 'getDecryptedBotToken: managed bot not found');
    throw new Error(`Managed bot not found: ${botId}`);
  }
  const token = decrypt(bot.encrypted_token, bot.token_iv, bot.token_key_version);
  tokenCache.set(botId, { token, expiresAt: now + CACHE_TTL_MS });
  logger.debug({ botId }, 'getDecryptedBotToken: decrypted and cached successfully');
  return token;
}

// M-01: Per-bot webhook secret cache — same TTL pattern as token cache.
export const webhookSecretCache = new Map<number, CacheEntry>();

/**
 * Invalidate a cached webhook secret entry. Call this after provisioning a bot
 * so the new secret is fetched from DB on the next request.
 */
export function invalidateBotWebhookSecretCache(botId: number): void {
  webhookSecretCache.delete(botId);
  logger.debug({ botId }, 'invalidateBotWebhookSecretCache: cache entry removed');
}

/**
 * Return the per-bot webhook secret, with 5-minute TTL caching.
 * Returns null if the bot has no secret set (legacy / pre-migration rows).
 */
export async function getBotWebhookSecretCached(botId: number): Promise<string | null> {
  const now = Date.now();
  const cached = webhookSecretCache.get(botId);
  if (cached && cached.expiresAt > now) {
    logger.debug({ botId }, 'getBotWebhookSecretCached: cache hit');
    return cached.token;
  }

  logger.debug({ botId }, 'getBotWebhookSecretCached: cache miss, querying DB');
  const secret = await managedBotQueries.getBotWebhookSecret(botId);
  if (secret !== null) {
    webhookSecretCache.set(botId, { token: secret, expiresAt: now + CACHE_TTL_MS });
  }
  logger.debug({ botId, found: secret !== null }, 'getBotWebhookSecretCached: result');
  return secret;
}

