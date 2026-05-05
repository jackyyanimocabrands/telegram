import { TelegramApiClient } from './telegram-api.js';
import { encrypt } from './encryption.js';
import { provisionChildBot, createChildBotHandler } from './child-bot.js';
import * as managedBotQueries from '../db/queries/managed-bots.js';
import * as userQueries from '../db/queries/users.js';
import * as webhookLogQueries from '../db/queries/webhook-log.js';
import { invalidateBotTokenCache, invalidateBotWebhookSecretCache } from './token-store.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ConflictError } from '../utils/errors.js';
import { randomBytes } from 'node:crypto';
import type { ManagedBotUpdated } from '../types/telegram.js';
import type { BotRegistry } from './bot-registry.js';

export class ManagedBotService {
  constructor(private readonly registry: BotRegistry) {}

  async handleManagedBotUpdated(
    updateId: number,
    managedBot: ManagedBotUpdated,
  ): Promise<void> {
    const { user, bot } = managedBot;

    logger.info({ updateId, userId: user.id, botId: bot.id, botUsername: bot.username }, 'handleManagedBotUpdated: start');

    // Atomic dedup — INSERT ON CONFLICT DO NOTHING eliminates TOCTOU race
    const logEntry = await webhookLogQueries.tryAcquireUpdate(bot.id, updateId, 'managed_bot_updated', managedBot);
    if (!logEntry) {
      logger.info({ updateId, botId: bot.id }, 'handleManagedBotUpdated: duplicate update, skipping');
      return;
    }

    const dbUser = await userQueries.findUserByTelegramId(user.id);
    if (!dbUser) {
      logger.error({ telegramId: user.id }, 'handleManagedBotUpdated: user not found in DB — cannot provision');
      await webhookLogQueries.markFailed(logEntry.id, 'user_not_found');
      return;
    }

    logger.debug({ updateId, botId: bot.id, dbUserId: dbUser.id }, 'handleManagedBotUpdated: user found, starting provisioning');

    try {
      // C-02 Fix Part 1: Reorder writes so the first DB write already carries the encrypted token.
      // 1. Rotate the token (Telegram API call — validate the bot exists)
      const rotatedToken = await TelegramApiClient.replaceManagedBotToken(env.BOT_TOKEN, bot.id);
      logger.info({ botId: bot.id }, 'handleManagedBotUpdated: rotated managed bot token');

      // 2. Encrypt the token before touching the DB
      const encrypted = encrypt(rotatedToken);
      logger.debug({ botId: bot.id }, 'handleManagedBotUpdated: encrypted rotated token');

      // 3. First DB write — PROVISIONING status with the encrypted token already present.
      //    No window where the DB row has PENDING + empty token buffer.
      // M-01: Generate a per-bot webhook secret so a leak is scoped to one bot.
      // B-5: Encrypt the webhook secret at rest using the same AES-256-GCM pattern as the bot token.
      const webhookSecret = randomBytes(32).toString('hex');
      const encryptedWebhookSecret = encrypt(webhookSecret);
      logger.debug({ botId: bot.id }, 'handleManagedBotUpdated: upserting with PROVISIONING status and encrypted token');
      await managedBotQueries.upsertManagedBot({
        botId: bot.id,
        botUsername: bot.username,
        ownerTelegramId: user.id,
        ownerUserId: dbUser.id,
        encryptedToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
        tokenKeyVersion: encrypted.keyVersion,
        status: 'PROVISIONING',
        webhookSecret: encryptedWebhookSecret.ciphertext,
        webhookSecretIv: encryptedWebhookSecret.iv,
        webhookSecretKeyVersion: encryptedWebhookSecret.keyVersion,
      });
      logger.debug({ botId: bot.id }, 'handleManagedBotUpdated: upserted with PROVISIONING status');

      // Invalidate any stale token cache entry for this bot
      invalidateBotTokenCache(bot.id);
      // M-01: Invalidate webhook secret cache so next request fetches the new secret from DB.
      invalidateBotWebhookSecretCache(bot.id);

      // 4. Call Telegram APIs (setCommands, setMyName, etc.)
      // provisionChildBot now only sets profile + commands (registry handles transport)
      await provisionChildBot(rotatedToken, bot.id, user.first_name);

      const updateMode = env.MANAGER_UPDATE_MODE; // child bots inherit manager's update mode
      // 5. Single atomic write — status + all flags + update_mode together
      await managedBotQueries.activateManagedBot(bot.id, updateMode);

      // Register the newly provisioned bot with the registry.
      // The registry receives the plaintext webhookSecret for in-memory comparison.
      const childWebhookUrl = `${env.BASE_URL}/webhook/bot/${bot.id}`;
      this.registry.registerBot({
        botId: bot.id,
        token: rotatedToken,
        updateMode,
        allowedUpdates: ['message', 'callback_query'],
        webhookUrl: childWebhookUrl,
        webhookSecret,
        handler: createChildBotHandler(bot.id),
      });

      await webhookLogQueries.markProcessed(logEntry.id);
      logger.info({ botId: bot.id, botUsername: bot.username }, 'handleManagedBotUpdated: bot fully provisioned and ACTIVE');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, botId: bot.id }, 'handleManagedBotUpdated: provisioning failed, setting DEACTIVATED');
      await webhookLogQueries.markFailed(logEntry.id, errorMessage);
      // Only set DEACTIVATED if this is not an ownership conflict
      if (!(err instanceof ConflictError)) {
        await managedBotQueries.updateManagedBotStatus(bot.id, 'DEACTIVATED');
        logger.warn({ botId: bot.id }, 'handleManagedBotUpdated: bot set to DEACTIVATED');
      }
      throw err;
    }
  }
}
