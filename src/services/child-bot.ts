import { TelegramApiClient } from './telegram-api.js';
import { getDecryptedBotToken } from './token-store.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { Message, CallbackQuery } from '../types/telegram.js';

export async function provisionChildBot(
  token: string,
  botId: number,
  ownerFirstName: string,
): Promise<void> {
  logger.info({ botId, ownerFirstName }, 'provisionChildBot: start');
  const webhookUrl = `${env.BASE_URL}/webhook/bot/${botId}`;

  await TelegramApiClient.setWebhook(token, webhookUrl, ['message', 'callback_query'], env.CHILD_WEBHOOK_SECRET);
  logger.info({ botId, webhookUrl }, 'provisionChildBot: webhook set');

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

  logger.info({ botId }, 'provisionChildBot: complete (webhook + profile + commands)');
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
