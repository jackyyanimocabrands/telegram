import { logger } from '../utils/logger.js';
import type { TelegramClient } from './telegram-api.js';
import type { ManagedBotUpdated } from '../types/telegram.js';
import { botManagementApi, BotManagementApiClient } from './bot-management-api.js';
import { getToolsetState } from '../db/queries/conversations.js';

/**
 * Handles a ManagedBotUpdated update from Telegram API 9.6.
 * Called when a user creates a managed bot via the deep link flow.
 * Fetches the bot token from Telegram, looks up the owner's email,
 * and registers the bot via the bot management API.
 */
export async function processManagedBotUpdated(
  update: ManagedBotUpdated,
  telegram: TelegramClient,
  managerBotToken: string,
  managerBotId: string = 'manager',
  client: BotManagementApiClient = botManagementApi,
): Promise<void> {
  const { user, bot } = update;
  logger.info(
    { userId: user.id, botId: bot.id, botUsername: bot.username },
    'processManagedBotUpdated: start',
  );

  // Step 1: fetch the managed bot token from Telegram
  let botToken: string;
  try {
    botToken = await telegram.getManagedBotToken(managerBotToken, bot.id);
    logger.debug({ botId: bot.id }, 'processManagedBotUpdated: token retrieved');
  } catch (err) {
    logger.error({ err, botId: bot.id }, 'processManagedBotUpdated: getManagedBotToken failed');
    return;
  }

  // Step 2: look up the owner's verified email from toolset state
  let userEmail: string | undefined;
  try {
    const toolsetState = await getToolsetState(managerBotId, user.id);
    if (typeof toolsetState.email === 'string' && toolsetState.email.length > 0) {
      userEmail = toolsetState.email;
    }
  } catch (err) {
    logger.warn({ err, userId: user.id }, 'processManagedBotUpdated: failed to load toolset state');
  }

  if (!userEmail) {
    logger.error(
      { userId: user.id, botId: bot.id },
      'processManagedBotUpdated: no verified email found for user — cannot register bot',
    );
    return;
  }

  // Step 3: register the bot via the bot management API
  try {
    const result = await client.createBot(userEmail, {
      name: bot.first_name,
      username: bot.username,
      botToken,
    });
    logger.info(
      { userId: user.id, botId: bot.id, botUsername: bot.username, result },
      'processManagedBotUpdated: bot registered successfully',
    );
  } catch (err) {
    logger.error(
      { err, userId: user.id, botId: bot.id },
      'processManagedBotUpdated: failed to register bot via management API',
    );
  }
}
