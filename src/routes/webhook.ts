import { Router, type Router as RouterType } from 'express';
import { verifyManagerWebhookSecret, verifyChildWebhookSecret } from '../middleware/webhook-secret.js';
import { handleManagedBotUpdated } from '../services/managed-bot.js';
import { handleChildBotMessage, handleChildBotCallback } from '../services/child-bot.js';
import { logger } from '../utils/logger.js';
import type { Update } from '../types/telegram.js';

export const webhookRouter: RouterType = Router();

webhookRouter.post(
  '/telegram',
  verifyManagerWebhookSecret,
  async (req, res) => {
    const update: Update = req.body;
    const updateTypes = Object.keys(update).filter(k => k !== 'update_id');
    logger.debug({ updateId: update.update_id, updateTypes }, 'Manager webhook received update');
    res.sendStatus(200);

    try {
      if (update.managed_bot) {
        logger.info({ updateId: update.update_id, botId: update.managed_bot.bot?.id }, 'Processing managed_bot update');
        await handleManagedBotUpdated(update.update_id, update.managed_bot);
      } else if (update.message) {
        logger.info(
          { updateId: update.update_id, from: update.message.from?.id, text: update.message.text },
          'Manager bot received message',
        );
      } else {
        logger.debug(
          { updateId: update.update_id, updateTypes },
          'Manager webhook: unhandled update type, ignoring',
        );
      }
    } catch (err) {
      logger.error({ err, updateId: update.update_id }, 'Error processing manager webhook update');
    }
  },
);

webhookRouter.post(
  '/bot/:botId',
  verifyChildWebhookSecret,
  async (req, res) => {
    const rawBotId = req.params.botId;
    const botId = parseInt(Array.isArray(rawBotId) ? rawBotId[0]! : rawBotId!, 10);
    const update: Update = req.body;

    if (Number.isNaN(botId)) {
      logger.warn({ rawBotId }, 'Child webhook received invalid botId, rejecting');
      res.sendStatus(400);
      return;
    }

    const updateTypes = Object.keys(update).filter(k => k !== 'update_id');
    logger.debug({ botId, updateId: update.update_id, updateTypes }, 'Child bot webhook received update');
    res.sendStatus(200);

    try {
      if (update.message) {
        logger.info({ botId, updateId: update.update_id, chatId: update.message.chat.id, from: update.message.from?.id }, 'Child bot processing message');
        await handleChildBotMessage(botId, update.message);
      } else if (update.callback_query) {
        logger.info({ botId, updateId: update.update_id, callbackQueryId: update.callback_query.id, from: update.callback_query.from.id }, 'Child bot processing callback query');
        await handleChildBotCallback(botId, update.callback_query);
      } else {
        logger.debug(
          { botId, updateId: update.update_id, updateTypes },
          'Child webhook: unhandled update type, ignoring',
        );
      }
    } catch (err) {
      logger.error({ err, botId, updateId: update.update_id }, 'Error processing child webhook update');
    }
  },
);
