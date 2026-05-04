import { Router, type Router as RouterType } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as managedBotQueries from '../db/queries/managed-bots.js';
import { logger } from '../utils/logger.js';
import type { BotStatusResponse } from '../types/api.js';

export const botStatusRouter: RouterType = Router();

botStatusRouter.get('/mine', requireAuth, async (req, res) => {
  const user = req.user!;
  logger.debug({ userId: user.id, telegramId: user.telegramId }, 'GET /api/bots/mine');

  try {
    const bot = await managedBotQueries.findManagedBotByOwnerTelegramId(user.telegramId);
    logger.debug({ userId: user.id, found: !!bot, botId: bot?.bot_id, status: bot?.status }, 'Bot status lookup complete');

    const response: BotStatusResponse = {
      ok: true,
      bot: bot
        ? {
            botId: bot.bot_id,
            botUsername: bot.bot_username ?? undefined,
            status: bot.status,
            webhookSet: bot.webhook_set,
            profileSet: bot.profile_set,
            commandsSet: bot.commands_set,
            createdAt: bot.created_at.toISOString(),
          }
        : null,
    };

    res.json(response);
  } catch (err) {
    logger.error({ err, userId: user.id, telegramId: user.telegramId }, 'Failed to fetch bot status');
    throw err;
  }
});
