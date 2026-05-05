import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';
import type { AuthenticatedUser } from '../types/api.js';

const APP_ISSUER = 'animocamind-telegram-connector';

/**
 * Issue an ES256 access token with a global version claim.
 * Bumping JWT_VERSION in env invalidates all previously issued tokens.
 */
export function issueAccessToken(user: AuthenticatedUser): string {
  logger.debug({ userId: user.id, telegramId: user.telegramId, ver: env.JWT_VERSION }, 'issueAccessToken: signing');
  try {
    const payload = {
      sub: user.id,
      telegramId: user.telegramId,
      firstName: user.firstName,
      username: user.username,
      ver: env.JWT_VERSION,
    };
    const token = jwt.sign(payload, env.ES256_PRIVATE_KEY, {
      algorithm: 'ES256',
      expiresIn: env.JWT_EXPIRES_IN,
      issuer: APP_ISSUER,
    });
    logger.debug({ userId: user.id }, 'issueAccessToken: signed successfully');
    return token;
  } catch (err) {
    logger.error({ err, userId: user.id }, 'issueAccessToken: failed to sign token');
    throw err;
  }
}

/**
 * Verify an ES256 access token.
 * Rejects if signature is invalid, token is expired, or JWT_VERSION doesn't match.
 */
export function verifyAccessToken(token: string): AuthenticatedUser {
  try {
    const decoded = jwt.verify(token, env.ES256_PUBLIC_KEY, {
      algorithms: ['ES256'],
      issuer: APP_ISSUER,
    }) as jwt.JwtPayload;

    if (decoded.ver !== env.JWT_VERSION) {
      logger.warn({ userId: decoded.sub, tokenVer: decoded.ver, envVer: env.JWT_VERSION }, 'verifyAccessToken: token version mismatch — token invalidated');
      throw new Error('Token version mismatch');
    }

    // M-11: Guard against NaN/Infinity if `sub` is malformed
    const id = parseInt(decoded.sub as string, 10);
    if (!Number.isFinite(id) || id <= 0) {
      throw new AppError('Invalid token subject', 401, 'INVALID_TOKEN');
    }

    const user: AuthenticatedUser = {
      id,
      telegramId: decoded.telegramId as number,
      firstName: decoded.firstName as string,
      username: decoded.username as string | undefined,
    };
    logger.debug({ userId: user.id, telegramId: user.telegramId }, 'verifyAccessToken: valid');
    return user;
  } catch (err) {
    logger.debug({ err }, 'verifyAccessToken: verification failed');
    throw err;
  }
}
