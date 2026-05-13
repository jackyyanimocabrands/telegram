import { HttpTelegramClient } from './telegram-api.js';
import { getDecryptedBotToken } from './token-store.js';
import { logger } from '../utils/logger.js';
import type { Message, CallbackQuery } from '../types/telegram.js';
import type { AgentService } from './agent.js';
import { env } from '../config/env.js';
import { splitAtSentenceBoundary } from '../utils/split-message.js';
import { toTelegramHtml } from '../utils/telegram-html.js';

/**
 * Factory function — tests can esmock this to provide a mock Telegram client.
 * Using a factory (not class instantiation) allows esmock to properly intercept.
 */
export function createTelegramClient() {
  return new HttpTelegramClient();
}

/** Module-level Telegram client instance. */
const telegram = createTelegramClient();

/** Maximum allowed message length before we reject with a user-facing error. */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Model allowlist per provider. Only these models can be selected via /provider.
 * If the user passes an unknown model we fall back to the first listed model.
 */
const ALLOWED_MODELS: Record<string, readonly string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openrouter: [
    'openai/gpt-4o',
    'anthropic/claude-3-5-sonnet',
    'deepseek/deepseek-chat',
    'google/gemini-2.0-flash-001',
    'meta-llama/llama-3.3-70b-instruct',
  ],
};

export async function provisionChildBot(
  token: string,
  botId: number,
  /** Pre-sanitized owner first name. Callers must strip unsafe characters and cap length before passing this value. */
  ownerFirstName: string,
): Promise<void> {
  logger.info({ botId, ownerFirstName }, 'provisionChildBot: start (profile + commands only)');

  // NOTE: setWebhook is NOT called here — BotRegistry owns transport wiring.
  await telegram.setMyName(token, `${ownerFirstName}'s AI Agent`);
  logger.debug({ botId }, 'provisionChildBot: name set');

  await telegram.setMyDescription(
    token,
    `This is ${ownerFirstName}'s personal AI bot powered by HelloMinds.`,
  );
  logger.debug({ botId }, 'provisionChildBot: description set');

  await telegram.setMyShortDescription(
    token,
    `${ownerFirstName}'s personal AI agent by HelloMinds.`,
  );
  logger.debug({ botId }, 'provisionChildBot: short description set');

  await telegram.setMyCommands(token, [
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'Show available commands' },
    { command: 'clear', description: 'Reset conversation history' },
    { command: 'provider', description: 'Switch AI model (/provider openai gpt-4o)' },
  ]);
  logger.debug({ botId }, 'provisionChildBot: commands set');

  logger.info({ botId }, 'provisionChildBot: complete (profile + commands)');
}

/**
 * Factory that returns a handler closure pre-bound to the given botId and agentService.
 * Use this when registering a bot with BotRegistry to avoid repeating
 * the inline dispatch arrow function at every call site.
 */
export function createChildBotHandler(botId: number, agentService: AgentService) {
  return async (update: { message?: Message; callback_query?: CallbackQuery }): Promise<void> => {
    if (update.message) await handleChildBotMessage(botId, update.message, agentService);
    else if (update.callback_query) await handleChildBotCallback(botId, update.callback_query);
  };
}

export async function handleChildBotMessage(
  botId: number,
  message: Message,
  agentService: AgentService,
): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text ?? '';

  // Log text length, not text content, to avoid persisting PII in logs
  logger.info({ botId, chatId, from: message.from?.id, textLength: text.length }, 'handleChildBotMessage: received');

  // Guard: need a user id to key conversations
  if (!message.from) {
    logger.info({ botId, chatId }, 'handleChildBotMessage: no from field, ignoring');
    return;
  }

  const userId = message.from.id;

  // Input length cap — reject oversized messages before any DB/LLM work
  if (text.length > MAX_MESSAGE_LENGTH) {
    const token = await getDecryptedBotToken(botId);
    await telegram.sendMessage(
      token,
      chatId,
      `Your message is too long (${text.length} chars). Please keep messages under ${MAX_MESSAGE_LENGTH} characters.`,
    );
    return;
  }

  // Hoist token before try so the catch block can send an error message
  // without a second getDecryptedBotToken call. If this throws, let it
  // propagate — the outer registry handler will catch it.
  const token = await getDecryptedBotToken(botId);

  try {
    const botIdStr = String(botId);

    // ── Command routing ────────────────────────────────────────────────────

    if (text.startsWith('/start')) {
      logger.debug({ botId, chatId }, 'handleChildBotMessage: handling /start');
      await telegram.sendMessage(
        token,
        chatId,
        "Hello! I'm your personal AI agent powered by HelloMinds. Type anything to start chatting, or use /help for available commands.",
      );
      return;
    }

    if (text.startsWith('/help')) {
      logger.debug({ botId, chatId }, 'handleChildBotMessage: handling /help');
      await telegram.sendMessage(
        token,
        chatId,
        '/start - Start the bot\n/help - Show available commands\n/clear - Reset conversation history\n/provider <name> [model] - Switch AI provider (e.g. /provider openai gpt-4o)',
      );
      return;
    }

    if (text.startsWith('/clear')) {
      logger.debug({ botId, chatId }, 'handleChildBotMessage: handling /clear');
      await agentService.clearContext(botIdStr, userId);
      await telegram.sendMessage(token, chatId, 'Conversation cleared! What would you like to talk about?');
      return;
    }

    if (text.startsWith('/provider')) {
      logger.debug({ botId, chatId }, 'handleChildBotMessage: handling /provider');
      const args = text.slice('/provider'.length).trim().split(/\s+/).filter(Boolean);
      const providerArg = args[0] ?? '';
      const modelArg = args[1] ?? '';

      if (!providerArg) {
        await telegram.sendMessage(
          token,
          chatId,
          'Invalid provider. Use: /provider openai [model] or /provider anthropic [model]',
        );
        return;
      }

      // Validate provider against allowlist
      const allowedModels = ALLOWED_MODELS[providerArg];
      if (!allowedModels) {
        await telegram.sendMessage(
          token,
          chatId,
          `Unknown provider "${providerArg}". Use: /provider openai or /provider anthropic`,
        );
        return;
      }

      // Validate model — fall back to first allowed model if unknown
      const effectiveModel = modelArg && allowedModels.includes(modelArg)
        ? modelArg
        : allowedModels[0]!;

      if (modelArg && !allowedModels.includes(modelArg)) {
        await telegram.sendMessage(
          token,
          chatId,
          `Unknown model "${modelArg}" for ${providerArg}. Using ${effectiveModel} instead. Available: ${allowedModels.join(', ')}`,
        );
      }

      try {
        await agentService.switchProvider(botIdStr, userId, providerArg, effectiveModel);
        await telegram.sendMessage(
          token,
          chatId,
          `Switched to ${providerArg} (${effectiveModel}).`,
        );
      } catch (err) {
        logger.warn({ err, provider: providerArg, model: effectiveModel }, 'handleChildBotMessage: switchProvider failed');
        await telegram.sendMessage(
          token,
          chatId,
          'Sorry, that provider is not available. Please check your command and try again.',
        );
      }
      return;
    }

    // ── Normal chat → AI streaming response ─────────────────────────────
    logger.debug({ botId, chatId }, 'handleChildBotMessage: routing to AI (streaming)');

    // Show "Thinking…" placeholder immediately
    await telegram.sendMessageDraft(token, chatId, 1, '');

    let accumulated = '';
    let lastSentAt = 0;
    const throttleMs = env.STREAM_THROTTLE_MS;

    for await (const chunk of agentService.chatStream(botIdStr, userId, text)) {
      accumulated += chunk;
      const now = Date.now();
      if (throttleMs === 0 || now - lastSentAt >= throttleMs) {
        await telegram.sendMessageDraft(token, chatId, 1, toTelegramHtml(accumulated), 'HTML');
        lastSentAt = now;
      }
    }

    // Persist the complete response (split at sentence boundary if > 4096 chars)
    const parts = splitAtSentenceBoundary(accumulated);
    for (const part of parts) {
      await telegram.sendMessage(token, chatId, toTelegramHtml(part), { parse_mode: 'HTML' });
    }
  } catch (err) {
    logger.error({ err, botId, chatId, from: message.from?.id }, 'handleChildBotMessage: failed');
    await telegram.sendMessage(
      token,
      chatId,
      'Sorry, I encountered an issue. Please try again in a moment.',
    );
  }
}

export async function handleChildBotCallback(botId: number, callbackQuery: CallbackQuery): Promise<void> {
  logger.debug(
    { botId, callbackQueryId: callbackQuery.id, from: callbackQuery.from.id, dataLength: callbackQuery.data?.length ?? 0 },
    'handleChildBotCallback: received',
  );

  try {
    const token = await getDecryptedBotToken(botId);
    await telegram.answerCallbackQuery(token, callbackQuery.id, 'Received');
    logger.debug({ botId, callbackQueryId: callbackQuery.id }, 'handleChildBotCallback: answered');
  } catch (err) {
    logger.error({ err, botId, callbackQueryId: callbackQuery.id, from: callbackQuery.from.id }, 'handleChildBotCallback: failed');
    throw err;
  }
}
