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

  const authDate = parseInt(fields.auth_date, 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;

  if (Number.isNaN(authDate)) {
    logger.warn({ telegramId: data.id }, 'verifyTelegramAuth: auth_date is NaN');
    return false;
  }
  if (ageSeconds < 0) {
    logger.warn({ telegramId: data.id, ageSeconds }, 'verifyTelegramAuth: auth_date is in the future');
    return false;
  }
  if (ageSeconds > 86400) {
    logger.warn({ telegramId: data.id, ageSeconds }, 'verifyTelegramAuth: auth_date too old (>24h)');
    return false;
  }

  logger.debug({ telegramId: data.id, ageSeconds }, 'verifyTelegramAuth: valid');
  return true;
}
