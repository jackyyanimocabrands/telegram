import { TelegramApiClient } from './telegram-api.js';
import { getDecryptedBotToken } from './token-store.js';
import { logger } from '../utils/logger.js';
import type { Message, CallbackQuery } from '../types/telegram.js';

export async function provisionChildBot(
  token: string,
  botId: number,
  ownerFirstName: string,
): Promise<void> {
  logger.info({ botId, ownerFirstName }, 'provisionChildBot: start (profile + commands only)');

  // NOTE: setWebhook is NOT called here — BotRegistry owns transport wiring.
  await TelegramApiClient.setMyName(token, `${ownerFirstName}'s AI Agent`);
  logger.debug({ botId }, 'provisionChildBot: name set');

  await TelegramApiClient.setMyDescription(
    token,
    `This is ${ownerFirstName}'s personal AI bot powered by Animocamind.`,
  );
  logger.debug({ botId }, 'provisionChildBot: description set');

  await TelegramApiClient.setMyShortDescription(
    token,
    `${ownerFirstName}'s personal AI agent by Animocamind.`,
  );
  logger.debug({ botId }, 'provisionChildBot: short description set');

  await TelegramApiClient.setMyCommands(token, [
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'Show help' },
    { command: 'settings', description: 'Manage your settings' },
  ]);
  logger.debug({ botId }, 'provisionChildBot: commands set');

  logger.info({ botId }, 'provisionChildBot: complete (profile + commands)');
}

/**
 * Factory that returns a handler closure pre-bound to the given botId.
 * Use this when registering a bot with BotRegistry to avoid repeating
 * the inline dispatch arrow function at every call site.
 */
export function createChildBotHandler(botId: number) {
  return async (update: { message?: Message; callback_query?: CallbackQuery }): Promise<void> => {
    if (update.message) await handleChildBotMessage(botId, update.message);
    else if (update.callback_query) await handleChildBotCallback(botId, update.callback_query);
  };
}

export async function handleChildBotMessage(botId: number, message: Message): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text ?? '';
  logger.info({ botId, chatId, from: message.from?.id, text }, 'handleChildBotMessage: received');

  try {
    const token = await getDecryptedBotToken(botId);

    if (text.startsWith('/start')) {
      logger.debug({ botId, chatId }, 'handleChildBotMessage: handling /start');
      await TelegramApiClient.sendMessage(token, chatId, "Hello! I'm your personal AI agent powered by Animocamind. How can I help you today?");
      return;
    }

    if (text.startsWith('/help')) {
      logger.debug({ botId, chatId }, 'handleChildBotMessage: handling /help');
      await TelegramApiClient.sendMessage(token, chatId, '/start - Start the bot\n/help - Show help\n/settings - Manage settings\n\nJust type a message to chat with me!');
      return;
    }

    logger.debug({ botId, chatId }, 'handleChildBotMessage: echoing message');
    // Strip Telegram markup characters from user input before echoing
    const sanitized = text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    await TelegramApiClient.sendMessage(token, chatId, `Echo: ${sanitized}`);
  } catch (err) {
    logger.error({ err, botId, chatId, from: message.from?.id }, 'handleChildBotMessage: failed');
    throw err;
  }
}

export async function handleChildBotCallback(botId: number, callbackQuery: CallbackQuery): Promise<void> {
  logger.info({ botId, callbackQueryId: callbackQuery.id, from: callbackQuery.from.id, data: callbackQuery.data }, 'handleChildBotCallback: received');

  try {
    const token = await getDecryptedBotToken(botId);
    await TelegramApiClient.answerCallbackQuery(token, callbackQuery.id, 'Received');
    logger.debug({ botId, callbackQueryId: callbackQuery.id }, 'handleChildBotCallback: answered');
  } catch (err) {
    logger.error({ err, botId, callbackQueryId: callbackQuery.id, from: callbackQuery.from.id }, 'handleChildBotCallback: failed');
    throw err;
  }
}
