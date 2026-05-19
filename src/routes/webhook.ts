import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { verifyManagerWebhookSecret } from '../middleware/webhook-secret.js';
import { logger } from '../utils/logger.js';
import type { Update } from '../types/telegram.js';
import type { BotRegistry } from '../services/bot-registry.js';

/**
 * Minimum shape required for a valid Telegram Update.
 * .passthrough() preserves all additional fields so downstream handlers
 * receive the full update object unmodified.
 */
const UpdateSchema = z.object({
  update_id: z.number().int().positive(),
}).passthrough();

export function createWebhookRouter(registry: BotRegistry): RouterType {
  const router = Router();

  router.post(
    '/telegram',
    verifyManagerWebhookSecret,
    async (req, res) => {
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, 'Manager webhook: malformed update body, ignoring');
        // Return 200 to prevent Telegram from retrying a permanently malformed update
        res.sendStatus(200);
        return;
      }
      const update = parsed.data as Update;
      const updateTypes = Object.keys(update).filter(k => k !== 'update_id');
      logger.debug({ updateId: update.update_id, updateTypes }, 'Manager webhook received update');
      res.sendStatus(200);
      // dispatch is fire-and-forget after 200 is sent
      void registry.dispatch('manager', update);
    },
  );

  return router;
}
