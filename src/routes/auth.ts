import { Router, type Router as RouterType } from 'express';
import { verifyTelegramAuth } from '../services/telegram-auth.js';
import { issueAccessToken } from '../services/session.js';
import * as userQueries from '../db/queries/users.js';
import { env } from '../config/env.js';
import { AuthenticationError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { TelegramLoginRequest, AuthResponse } from '../types/api.js';

export const authRouter: RouterType = Router();

/**
 * B-1: Validate that a photo_url from the Telegram Login Widget is a genuine Telegram CDN URL.
 * Even though the data is HMAC-signed, the value is still attacker-influenced — an attacker
 * who controls their own bot token can craft a signed payload with an arbitrary URL.
 * We accept only https://*.telegram.org and https://t.me to prevent SSRF and open-redirect risks.
 */
function sanitizePhotoUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    if (!parsed.hostname.endsWith('.telegram.org') && parsed.hostname !== 't.me') return undefined;
    return url;
  } catch {
    return undefined;
  }
}

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
    if (!Number.isFinite(telegramId) || telegramId <= 0) {
      throw new ValidationError('Invalid Telegram user ID');
    }
    const user = await userQueries.upsertUser({
      telegramId,
      firstName: data.first_name,
      lastName: data.last_name,
      username: data.username,
      photoUrl: sanitizePhotoUrl(data.photo_url),
    });

    logger.info({ userId: user.id, telegramId }, 'User authenticated via Telegram');

    const authUser = {
      id: user.id,
      telegramId: user.telegram_id,
      firstName: user.first_name,
      username: user.username ?? undefined,
    };

    const accessToken = issueAccessToken(authUser);

    // Sanitize username: Telegram usernames are [a-zA-Z0-9_], 5–32 chars.
    // Strip anything outside that set before embedding in the deep-link URL.
    const rawUsername = data.username ?? data.first_name.toLowerCase();
    const safeUsername = rawUsername
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .slice(0, 32);
    const suggestedUsername = `${safeUsername}_animoca_bot`;
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
