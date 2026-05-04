import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { ForbiddenError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Constant-time comparison that does not leak secret length via timing. */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Pad both to the same length to avoid length-based timing leak
  const maxLen = Math.max(bufA.length, bufB.length);
  if (maxLen === 0) return bufA.length === bufB.length;
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && bufA.length === bufB.length;
}

export function verifyManagerWebhookSecret(req: Request, _res: Response, next: NextFunction): void {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (typeof secret !== 'string' || !timingSafeCompare(secret, env.WEBHOOK_SECRET)) {
    logger.warn({ ip: req.ip, secretProvided: !!secret }, 'Invalid manager webhook secret');
    next(new ForbiddenError('Invalid webhook secret'));
    return;
  }
  next();
}

export function verifyChildWebhookSecret(req: Request, _res: Response, next: NextFunction): void {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (typeof secret !== 'string' || !timingSafeCompare(secret, env.CHILD_WEBHOOK_SECRET)) {
    logger.warn({ ip: req.ip, botId: req.params.botId }, 'Invalid child webhook secret');
    next(new ForbiddenError('Invalid webhook secret'));
    return;
  }
  next();
}
