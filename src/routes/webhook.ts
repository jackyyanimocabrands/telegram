import { Router, type Router as RouterType } from 'express';
import { verifyManagerWebhookSecret, verifyChildWebhookSecret } from '../middleware/webhook-secret.js';
import { logger } from '../utils/logger.js';
import type { Update } from '../types/telegram.js';
import type { BotRegistry } from '../services/bot-registry.js';

export function createWebhookRouter(registry: BotRegistry): RouterType {
  const router = Router();

  router.post(
    '/telegram',
    verifyManagerWebhookSecret,
    async (req, res) => {
      const update: Update = req.body;
      const updateTypes = Object.keys(update).filter(k => k !== 'update_id');
      logger.debug({ updateId: update.update_id, updateTypes }, 'Manager webhook received update');
      res.sendStatus(200);
      // dispatch is fire-and-forget after 200 is sent
      void registry.dispatch('manager', update);
    },
  );

  router.post(
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
      void registry.dispatch(botId, update);
    },
  );

  return router;
}
