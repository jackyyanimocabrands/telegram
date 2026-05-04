import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/session.js';
import { AuthenticationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { AuthenticatedUser } from '../types/api.js';

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn({ ip: req.ip, path: req.path }, 'requireAuth: missing or malformed Authorization header');
    next(new AuthenticationError('Missing or malformed Authorization header'));
    return;
  }
  const token = authHeader.slice(7);
  try {
    const user: AuthenticatedUser = verifyAccessToken(token);
    logger.debug({ userId: user.id, telegramId: user.telegramId, path: req.path }, 'requireAuth: token verified');
    req.user = user;
    next();
  } catch (err) {
    logger.warn({ ip: req.ip, path: req.path, err }, 'requireAuth: invalid or expired access token');
    next(new AuthenticationError('Invalid or expired access token'));
  }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      req.user = verifyAccessToken(token);
      logger.debug({ userId: req.user?.id, path: req.path }, 'optionalAuth: token resolved');
    } catch (err) {
      logger.debug({ ip: req.ip, path: req.path, err }, 'optionalAuth: token invalid, continuing unauthenticated');
    }
  } else {
    logger.debug({ ip: req.ip, path: req.path }, 'optionalAuth: no token provided, continuing unauthenticated');
  }
  next();
}
