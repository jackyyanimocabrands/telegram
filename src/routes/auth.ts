import { Router, type Router as RouterType } from 'express';
import { verifyTelegramAuth } from '../services/telegram-auth.js';
import { issueAccessToken } from '../services/session.js';
import * as userQueries from '../db/queries/users.js';
import { env } from '../config/env.js';
import { AuthenticationError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { TelegramLoginRequest, AuthResponse } from '../types/api.js';

export const authRouter: RouterType = Router();

/** Public endpoint — returns bot username for the Telegram Login Widget. */
authRouter.get('/config', (_req, res) => {
  res.json({ botUsername: env.BOT_USERNAME });
});

authRouter.post<never, AuthResponse | { ok: false; error: string }, TelegramLoginRequest>(
  '/telegram',
  async (req, res) => {
    const data = req.body;
    logger.debug({ telegramId: data?.id, hasHash: !!data?.hash }, 'POST /api/auth/telegram received');

    if (!data?.id || !data?.hash || !data?.auth_date || !data?.first_name) {
      logger.warn({ body: data }, 'POST /api/auth/telegram: missing required fields');
      throw new ValidationError('Missing required Telegram auth fields');
    }

    if (!verifyTelegramAuth(data, env.BOT_TOKEN)) {
      logger.warn({ telegramId: data.id }, 'POST /api/auth/telegram: hash verification failed');
      throw new AuthenticationError('Invalid Telegram auth data');
    }

    const telegramId = parseInt(data.id, 10);
    const user = await userQueries.upsertUser({
      telegramId,
      firstName: data.first_name,
      lastName: data.last_name,
      username: data.username,
      photoUrl: data.photo_url,
    });

    logger.info({ userId: user.id, telegramId }, 'User authenticated via Telegram');

    const authUser = {
      id: user.id,
      telegramId: user.telegram_id,
      firstName: user.first_name,
      username: user.username ?? undefined,
    };

    const accessToken = issueAccessToken(authUser);

    const suggestedUsername = `${data.username ?? data.first_name.toLowerCase()}_animoca_bot`;
    const deepLink = `https://t.me/newbot/${env.BOT_USERNAME}/${suggestedUsername}?name=${encodeURIComponent(data.first_name + "'s AI Agent")}`;

    logger.debug({ userId: user.id, telegramId, deepLink }, 'Access token issued, sending auth response');

    res.json({
      ok: true,
      user: {
        id: user.id,
        telegramId: user.telegram_id,
        firstName: user.first_name,
        lastName: user.last_name ?? undefined,
        username: user.username ?? undefined,
        photoUrl: user.photo_url ?? undefined,
      },
      accessToken,
      deepLink,
    });
  },
);
