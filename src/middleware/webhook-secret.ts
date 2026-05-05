import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { ForbiddenError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { getBotWebhookSecretCached } from '../services/token-store.js';

/**
 * Module-level key generated once at startup.
 * Double-HMAC comparison: both inputs are HMACed to a fixed 32-byte output
 * before comparison, so timingSafeEqual always compares buffers of equal
 * length regardless of the actual string lengths — eliminating length-based
 * timing side-channels.
 */
const COMPARE_KEY = randomBytes(32);

function safeCompare(a: string, b: string): boolean {
  const hmacA = createHmac('sha256', COMPARE_KEY).update(a).digest();
  const hmacB = createHmac('sha256', COMPARE_KEY).update(b).digest();
  return timingSafeEqual(hmacA, hmacB);
}

export function verifyManagerWebhookSecret(req: Request, _res: Response, next: NextFunction): void {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (typeof secret !== 'string' || !safeCompare(secret, env.WEBHOOK_SECRET)) {
    logger.warn({ ip: req.ip, secretProvided: !!secret }, 'Invalid manager webhook secret');
    next(new ForbiddenError('Invalid webhook secret'));
    return;
  }
  next();
}

/**
 * M-01: Async middleware — looks up the per-bot webhook secret from the DB (with TTL cache).
 * Falls back to the shared CHILD_WEBHOOK_SECRET env var for legacy bots (NULL in DB).
 *
 * Requires req.params.botId to be set (available because the route is /bot/:botId).
 */
export async function verifyChildWebhookSecret(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    if (typeof provided !== 'string') {
      logger.warn({ ip: req.ip, botId: req.params.botId }, 'Missing child webhook secret');
      next(new ForbiddenError('Missing webhook secret'));
      return;
    }

    // botId is available from req.params because the route is /bot/:botId.
    // The route handler validates the parsed integer, but we only need the raw
    // string here for the lookup — parseInt is safe, NaN/invalid → DB miss → fallback.
    const rawBotId = req.params['botId'];
    const botId = parseInt(Array.isArray(rawBotId) ? rawBotId[0]! : rawBotId!, 10);

    // Try per-bot secret first (M-01)
    let expected: string | null = Number.isFinite(botId) ? await getBotWebhookSecretCached(botId) : null;

    // Fall back to shared env var for legacy / unprovisioned bots
    if (expected === null) {
      expected = env.CHILD_WEBHOOK_SECRET;
    }

    if (!safeCompare(provided, expected)) {
      logger.warn({ ip: req.ip, botId: req.params.botId }, 'Invalid child webhook secret');
      next(new ForbiddenError('Invalid webhook secret'));
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
}
