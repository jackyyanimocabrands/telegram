import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { TelegramAuthData } from '../types/telegram.js';

export function verifyTelegramAuth(data: TelegramAuthData, botToken: string): boolean {
  const { hash, ...fields } = data;
  logger.debug({ telegramId: data.id }, 'verifyTelegramAuth: start');

  if (!hash) {
    logger.warn({ telegramId: data.id }, 'verifyTelegramAuth: missing hash');
    return false;
  }

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key as keyof typeof fields]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();

  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // timingSafeEqual throws RangeError on length mismatch — guard against it
  const computedBuf = Buffer.from(computedHash, 'hex');
  const hashBuf = Buffer.from(hash, 'hex');
  if (computedBuf.length !== hashBuf.length) {
    logger.warn({ telegramId: data.id, expectedLen: computedBuf.length, gotLen: hashBuf.length }, 'verifyTelegramAuth: hash length mismatch');
    return false;
  }
  if (!crypto.timingSafeEqual(computedBuf, hashBuf)) {
    logger.warn({ telegramId: data.id }, 'verifyTelegramAuth: HMAC hash mismatch');
    return false;
  }

  const authDate = fields.auth_date;

  // Reject non-numeric auth_date (parseInt silently ignores trailing chars)
  if (!/^\d+$/.test(authDate)) {
    logger.warn({ telegramId: data.id }, 'verifyTelegramAuth: auth_date is not a valid integer string');
    return false;
  }
  const ts = parseInt(authDate, 10);
  const ageSeconds = (Date.now() / 1000) - ts;

  // Allow up to 60 seconds in the future to tolerate clock skew; reject further
  if (ageSeconds < -60) {
    logger.warn({ telegramId: data.id, ageSeconds }, 'verifyTelegramAuth: auth_date is too far in the future');
    return false;
  }
  if (ageSeconds > 300) {
    logger.warn({ telegramId: data.id, ageSeconds }, 'verifyTelegramAuth: auth_date too old (>5min)');
    return false;
  }

  logger.debug({ telegramId: data.id, ageSeconds }, 'verifyTelegramAuth: valid');
  return true;
}
