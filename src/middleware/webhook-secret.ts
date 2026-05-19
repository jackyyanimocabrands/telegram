import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { ForbiddenError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

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
