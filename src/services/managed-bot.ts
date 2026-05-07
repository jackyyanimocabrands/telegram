import type { TelegramClient } from './telegram-api.js';
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
  constructor(
    private readonly registry: BotRegistry,
    private readonly telegram: TelegramClient,
  ) {}

  /**
   * Phase 1 of bot provisioning: rotate the bot token and persist the PROVISIONING
   * record to the DB. This must succeed before Phase 2 (Telegram API calls) is attempted.
   */
  async #rotateAndPersistToken(
    bot: ManagedBotUpdated['bot'],
    ownerTelegramId: number,
    ownerUserId: number,
  ): Promise<{ rotatedToken: string; webhookSecret: string }> {
    const rotatedToken = await this.telegram.replaceManagedBotToken(env.BOT_TOKEN, bot.id);
    logger.info({ botId: bot.id }, 'handleManagedBotUpdated: rotated managed bot token');

    const encrypted = encrypt(rotatedToken);
    logger.debug({ botId: bot.id }, 'handleManagedBotUpdated: encrypted rotated token');

    const webhookSecret = randomBytes(32).toString('hex');
    const encryptedWebhookSecret = encrypt(webhookSecret);
    logger.debug({ botId: bot.id }, 'handleManagedBotUpdated: upserting with PROVISIONING status and encrypted token');

    await managedBotQueries.upsertManagedBot({
      botId: bot.id,
      botUsername: bot.username,
      ownerTelegramId,
      ownerUserId,
      encryptedToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenKeyVersion: encrypted.keyVersion,
      status: 'PROVISIONING',
      webhookSecret: encryptedWebhookSecret.ciphertext,
      webhookSecretIv: encryptedWebhookSecret.iv,
      webhookSecretKeyVersion: encryptedWebhookSecret.keyVersion,
    });
    logger.debug({ botId: bot.id }, 'handleManagedBotUpdated: upserted with PROVISIONING status');

    invalidateBotTokenCache(bot.id);
    invalidateBotWebhookSecretCache(bot.id);

    return { rotatedToken, webhookSecret };
  }

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
      // Phase 1: rotate token + write PROVISIONING record
      const { rotatedToken, webhookSecret } = await this.#rotateAndPersistToken(
        bot,
        user.id,
        dbUser.id,
      );

      // Phase 2: Telegram API calls — profile + commands (transport is registry's responsibility)
      await provisionChildBot(rotatedToken, bot.id, user.first_name);

      // Phase 3: activate + register
      const updateMode = env.MANAGER_UPDATE_MODE; // child bots inherit manager's update mode
      await managedBotQueries.activateManagedBot(bot.id, updateMode);

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
      // Only set DEACTIVATED and clean up registry if this is not an ownership conflict
      if (!(err instanceof ConflictError)) {
        await managedBotQueries.updateManagedBotStatus(bot.id, 'DEACTIVATED');
        // Clean up the registry entry — the bot is now inconsistent otherwise
        this.registry.deregisterBot(bot.id);
        logger.warn({ botId: bot.id }, 'handleManagedBotUpdated: bot set to DEACTIVATED');
      }
      throw err;
    }
  }
}
