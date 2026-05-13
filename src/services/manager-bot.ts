import { logger } from '../utils/logger.js';
import { findManagedBotByOwner } from '../db/queries/managed-bots.js';
import { env } from '../config/env.js';
import { interpolate } from '../utils/interpolate.js';
import type { TelegramClient } from './telegram-api.js';
import type { AgentService } from './agent.js';
import type { Message } from '../types/telegram.js';
import { splitAtSentenceBoundary, trimToLastSentence } from '../utils/split-message.js';
import { toTelegramMarkdownV2 } from '../utils/telegram-markdownv2.js';

const TELEGRAM_USERNAME_RE = /^[a-zA-Z0-9_]{5,32}$/;

export async function handleManagerBotMessage(
  message: Message,
  telegram: TelegramClient,
  agentService: AgentService,
  managerBotToken: string,
  managerBotId: string,
  _baseUrl: string,
  botUsername: string,
): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  const text = message.text ?? '';

  if (!from) {
    logger.info({ chatId }, 'handleManagerBotMessage: no from field, ignoring');
    return;
  }

  logger.info(
    { chatId, userId: from.id, from, textLength: text.length },
    'handleManagerBotMessage: start',
  );

  // Sanitize first_name to prevent prompt injection via user-controlled fields
  const safeName = (from.first_name ?? 'there')
    .replace(/[^a-zA-Z0-9 \-']/g, '')
    .slice(0, 50)
    .trim() || 'there';

  // Validate username against Telegram's documented format before embedding in URLs
  const safeUsername =
    from.username && TELEGRAM_USERNAME_RE.test(from.username) ? from.username : null;

  try {
    // Determine conversation mode based on whether user has an ACTIVE bot
    const managedBot = await findManagedBotByOwner(from.id);

    let systemPrompt: string;

    if (managedBot?.status === 'ACTIVE') {
      // Settings/billing mode — bot is live, manager handles platform support
      const template =
        (env.MANAGER_SETTINGS_PROMPT && env.MANAGER_SETTINGS_PROMPT.trim()) ||
        `You are HelloMinds' platform assistant for {name}. ` +
        `Their personal AI agent @{botUsername} is live and handles general conversations. ` +
        `Your role is to help with account settings, billing, and platform-level questions. ` +
        `Be concise and direct.`;

      systemPrompt = interpolate(template, {
        name: safeName,
        botUsername: managedBot.bot_username ?? '',
      });
    } else {
      // Onboarding mode — guide user to create their personal bot
      const suggestedUsername = safeUsername
        ? `${safeUsername}_ai_bot`
        : `user${from.id}_bot`;
      const deepLink =
        `https://t.me/newbot/${botUsername}/${suggestedUsername}` +
        `?name=${encodeURIComponent(`${safeName}'s Bot`)}`;

      const template =
        (env.MANAGER_ONBOARDING_PROMPT && env.MANAGER_ONBOARDING_PROMPT.trim()) ||
        `You are an onboarding assistant for HelloMinds. ` +
        `Help the user understand what HelloMinds does and guide them to create their personal AI agent bot. ` +
        `When the time is right, share this deep link with them: {deepLink}. ` +
        `Be conversational, helpful, and answer any questions they have.`;

      systemPrompt = interpolate(template, { name: safeName, deepLink });

      // Append status hint if bot exists but not yet active
      if (managedBot?.status === 'PENDING' || managedBot?.status === 'PROVISIONING') {
        systemPrompt += ` Note: the user's bot is currently being set up.`;
      }
    }

    // draft_id: unique integer per message
    const draftId = Math.floor(Date.now() + Math.random() * 1000);

    // tryTyping: sendChatAction with internal 4s throttle — failure is non-fatal
    const TYPING_REFRESH_MS = 4000;
    let lastTypingAt = 0;
    const tryTyping = async (): Promise<void> => {
      const now = Date.now();
      if (now - lastTypingAt < TYPING_REFRESH_MS) return;
      lastTypingAt = now;
      try {
        await telegram.sendChatAction(managerBotToken, chatId, 'typing');
      } catch (err) {
        logger.warn({ err, chatId }, 'sendChatAction failed (non-fatal)');
      }
    };

    // Thinking bubble: plain text, no parse_mode; delayed 250 ms so fast replies don't flash
    setTimeout(() => {
      telegram.sendMessageDraft(managerBotToken, chatId, draftId, 'Thinking').catch((err: unknown) => {
        logger.warn({ err, chatId }, 'sendMessageDraft (thinking) failed (non-fatal)');
      });
    }, 250);

    let accumulated = '';
    let lastSentAt = 0;
    const throttleMs = env.STREAM_THROTTLE_MS;

    for await (const chunk of agentService.chatStream(managerBotId, from.id, text, systemPrompt)) {
      accumulated += chunk;
      const now = Date.now();
      await tryTyping();
      if (throttleMs === 0 || now - lastSentAt >= throttleMs) {
        const displayText = trimToLastSentence(accumulated);
        if (displayText) {
          telegram.sendMessageDraft(managerBotToken, chatId, draftId, toTelegramMarkdownV2(displayText), 'MarkdownV2').catch((err: unknown) => {
            logger.warn({ err, chatId }, 'sendMessageDraft (stream) failed (non-fatal)');
          });
          lastSentAt = now;
        }
      }
    }

    // Final reply: splitAtSentenceBoundary guards against 4096-char Telegram limit
    const parts = splitAtSentenceBoundary(accumulated);
    for (const part of parts) {
      await telegram.sendMessage(managerBotToken, chatId, toTelegramMarkdownV2(part), { parse_mode: 'MarkdownV2' });
    }

    logger.debug({ chatId, userId: from.id }, 'handleManagerBotMessage: reply sent');
  } catch (err) {
    logger.error({ err, chatId, userId: from?.id }, 'handleManagerBotMessage: error');
    try {
      await telegram.sendMessage(
        managerBotToken,
        chatId,
        'Sorry, I encountered an issue. Please try again in a moment.',
      );
    } catch (sendErr) {
      logger.error({ err: sendErr, chatId }, 'handleManagerBotMessage: failed to send error fallback');
    }
  }
}
