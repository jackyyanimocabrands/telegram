import { logger } from '../utils/logger.js';
import { findManagedBotByOwner } from '../db/queries/managed-bots.js';
import type { TelegramClient } from './telegram-api.js';
import type { AgentService } from './agent.js';
import type { Message } from '../types/telegram.js';

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
    { chatId, userId: from.id, textLength: text.length },
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
      systemPrompt =
        `You are Animocamind's platform assistant for ${safeName}. ` +
        `Their personal AI agent @${managedBot.bot_username} is live and handles general conversations. ` +
        `Your role is to help with account settings, billing, and platform-level questions. ` +
        `Be concise and direct.`;
    } else {
      // Onboarding mode — guide user to create their personal bot
      const suggestedUsername = safeUsername
        ? `${safeUsername}_ai_bot`
        : `user${from.id}_bot`;
      const deepLink =
        `https://t.me/newbot/${botUsername}/${suggestedUsername}` +
        `?name=${encodeURIComponent(`${safeName}'s Bot`)}`;

      systemPrompt =
        `You are an onboarding assistant for Animocamind. ` +
        `Help the user understand what Animocamind does and guide them to create their personal AI agent bot. ` +
        `When the time is right, share this deep link with them: ${deepLink}. ` +
        `Be conversational, helpful, and answer any questions they have.`;

      // Append status hint if bot exists but not yet active
      if (managedBot?.status === 'PENDING' || managedBot?.status === 'PROVISIONING') {
        systemPrompt += ` Note: the user's bot is currently being set up.`;
      }
    }

    const reply = await agentService.chat(managerBotId, from.id, text, systemPrompt);
    await telegram.sendMessage(managerBotToken, chatId, reply);

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
