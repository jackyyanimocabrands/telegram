import { logger } from '../utils/logger.js';
import { findManagedBotByOwner } from '../db/queries/managed-bots.js';
import { env } from '../config/env.js';
import { interpolate } from '../utils/interpolate.js';
import type { TelegramClient } from './telegram-api.js';
import type { AgentService } from './agent.js';
import type { Message } from '../types/telegram.js';
import { splitAtSentenceBoundary } from '../utils/split-message.js';

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

    // Show "Thinking…" placeholder immediately
    await telegram.sendMessageDraft(managerBotToken, chatId, 1, '');

    let accumulated = '';
    let lastSentAt = 0;
    const throttleMs = env.STREAM_THROTTLE_MS;

    for await (const chunk of agentService.chatStream(managerBotId, from.id, text, systemPrompt)) {
      accumulated += chunk;
      const now = Date.now();
      if (throttleMs === 0 || now - lastSentAt >= throttleMs) {
        await telegram.sendMessageDraft(managerBotToken, chatId, 1, accumulated);
        lastSentAt = now;
      }
    }

    // Persist the complete response (split at sentence boundary if > 4096 chars)
    const parts = splitAtSentenceBoundary(accumulated);
    for (const part of parts) {
      await telegram.sendMessage(managerBotToken, chatId, part);
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
