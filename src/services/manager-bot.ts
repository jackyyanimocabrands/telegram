import { logger } from '../utils/logger.js';
import { findManagedBotByOwner } from '../db/queries/managed-bots.js';
import { env } from '../config/env.js';
import { interpolate } from '../utils/interpolate.js';
import type { TelegramClient } from './telegram-api.js';
import type { AgentService } from './agent.js';
import type { Message } from '../types/telegram.js';
import { splitAtSentenceBoundary } from '../utils/split-message.js';
import { toTelegramMarkdownV2 } from '../utils/telegram-markdownv2.js';
import { checkThrottle } from './conversation-throttle.js';
import { acquireLock, releaseLock } from './conversation-lock.js';
import { managerQueue as defaultManagerQueue } from '../queues/manager-queue.js';
import type { Queue } from 'bullmq';
import type { ManagerMessageJobData } from '../queues/types.js';

const TELEGRAM_USERNAME_RE = /^[a-zA-Z0-9_]{5,32}$/;

/**
 * Webhook-facing function. Checks throttle + lock gate, enqueues the job,
 * and returns immediately (~2ms). All LLM work happens in the worker.
 */
export async function enqueueManagerMessage(
  message: Message,
  telegram: TelegramClient,
  managerBotToken: string,
  botUsername: string,
  queue: Queue<ManagerMessageJobData> = defaultManagerQueue,
): Promise<void> {
  const chatId = message.chat.id;
  const from = message.from;
  const text = message.text ?? '';

  if (!from) {
    logger.info({ chatId }, 'enqueueManagerMessage: no from field, ignoring');
    return;
  }

  logger.info({ chatId, userId: from.id, textLength: text.length }, 'enqueueManagerMessage: received');
  logger.trace({ chatId, userId: from.id, text }, 'enqueueManagerMessage: message text');

  const conversationId = `manager:${from.id}`;

  // Step 1: throttle check
  if (env.MANAGER_THROTTLE_MS > 0) {
    try {
      const throttle = await checkThrottle(conversationId, env.MANAGER_THROTTLE_MS);
      if (!throttle.allowed) {
        const seconds = Math.ceil(throttle.retryAfterMs / 1000);
        await telegram.sendMessage(
          managerBotToken,
          chatId,
          `Please wait ${seconds} second${seconds !== 1 ? 's' : ''} before sending another message.`,
        );
        return;
      }
    } catch (err) {
      logger.warn({ err, userId: from.id }, 'enqueueManagerMessage: throttle check failed, proceeding');
    }
  }

  // Step 2: acquire processing lock
  try {
    const locked = await acquireLock(conversationId, env.LOCK_TTL_SECS);
    if (!locked) {
      await telegram.sendMessage(
        managerBotToken,
        chatId,
        "I'm still working on your previous message, please wait a moment.",
      );
      return;
    }
  } catch (err) {
    logger.warn({ err, userId: from.id }, 'enqueueManagerMessage: lock check failed, proceeding');
  }

  // Step 3: enqueue
  try {
    await queue.add(
      'manager-message',
      {
        conversationId,
        userId: from.id,
        chatId,
        messageId: message.message_id,
        text,
        firstName: from.first_name ?? '',
        username: from.username,
      },
      { jobId: `msg:${message.message_id}` },
    );
    logger.info({ chatId, userId: from.id, conversationId }, 'enqueueManagerMessage: enqueued');
  } catch (err) {
    logger.error({ err, chatId, userId: from.id }, 'enqueueManagerMessage: failed to enqueue');
    // Release lock since job was never queued
    try { await releaseLock(conversationId); } catch { /* ignore */ }
    try {
      await telegram.sendMessage(managerBotToken, chatId, 'Sorry, I encountered an issue. Please try again in a moment.');
    } catch { /* ignore */ }
  }
}

/**
 * Worker-facing function. Performs the full LLM + streaming + Telegram reply.
 * Called by the BullMQ worker process.
 * Caller is responsible for releasing the lock in a finally block.
 */
export async function processManagerMessage(
  jobData: ManagerMessageJobData,
  telegram: TelegramClient,
  agentService: AgentService,
  managerBotToken: string,
  managerBotId: string,
  _baseUrl: string,
  botUsername: string,
): Promise<void> {
  const { chatId, userId, text, firstName, username, conversationId } = jobData;

  logger.info({ chatId, userId, conversationId }, 'processManagerMessage: start');

  const safeName = (firstName ?? 'there')
    .replace(/[^a-zA-Z0-9 \-']/g, '')
    .slice(0, 50)
    .trim() || 'there';

  const safeUsername = username && TELEGRAM_USERNAME_RE.test(username) ? username : null;

  try {
    const managedBot = await findManagedBotByOwner(userId);

    let systemPrompt: string;

    if (managedBot?.status === 'ACTIVE') {
      const template =
        (env.MANAGER_SETTINGS_PROMPT && env.MANAGER_SETTINGS_PROMPT.trim()) ||
        `You are HelloMinds' platform assistant for {name}.` +
        `ONLY response in short messages be consie and direct, reply nicely to refuse user's request for long answers or lengthy tasks.` +
        `ONLY response to questions about HelloMinds' platform, any other topics should be politely declined.` +
        `Your tone will be supportive, friendly and humble. Language should be professional and simple.` +
        `DO NOT say anything inappropriate or offensive, refrain from using slang or casual language.` +
        `Their personal AI agent @{botUsername} is live and handles general conversations.` +
        `Mind is a specialized AI agent that can assist with tasks, research, work.` +
        `Your role is to help with account creation, and mind creation`;

      systemPrompt = interpolate(template, {
        name: safeName,
        botUsername: managedBot.bot_username ?? '',
      });
    } else {
      const suggestedUsername = safeUsername
        ? `${safeUsername}_ai_bot`
        : `user${userId}_bot`;
      const deepLink =
        `https://t.me/newbot/${botUsername}/${suggestedUsername}` +
        `?name=${encodeURIComponent(`${safeName}'s Bot`)}`;

      const template =
        (env.MANAGER_ONBOARDING_PROMPT && env.MANAGER_ONBOARDING_PROMPT.trim()) ||
        `You are an onboarding assistant for HelloMinds. ` +
        `ONLY response in short messages, reply nicely to refuse user's request for long answers or lengthy tasks. ` +
        `ONLY response to questions about HelloMinds' platform, any other topics should be politely declined.` +
        `Your responses cannot be more than 500 characters.` +
        `Help the user understand what HelloMinds does and guide them to create their personal AI agent bot. ` +
        `When the time is right, share this deep link with them: {deepLink}. ` +
        `Be conversational, helpful, and answer any questions they have.`;

      systemPrompt = interpolate(template, { name: safeName, deepLink });

      if (managedBot?.status === 'PENDING' || managedBot?.status === 'PROVISIONING') {
        systemPrompt += ` Note: the user's bot is currently being set up.`;
      }
    }

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

    setTimeout(() => {
      telegram.sendMessageDraft(managerBotToken, chatId, 1, 'Thinking').catch((err: unknown) => {
        logger.warn({ err, chatId }, 'sendMessageDraft (thinking) failed (non-fatal)');
      });
    }, 250);

    let accumulated = '';
    let lastSentAt = 0;
    const throttleMs = env.STREAM_THROTTLE_MS;
    const draftId = Math.floor(Date.now() + Math.random() * 1000);
    for await (const chunk of agentService.chatStream(managerBotId, userId, text, systemPrompt)) {
      accumulated += chunk;
      const now = Date.now();
      await tryTyping();
      if (throttleMs === 0 || now - lastSentAt >= throttleMs) {
        telegram.sendMessageDraft(managerBotToken, chatId, draftId, toTelegramMarkdownV2(accumulated), 'MarkdownV2').catch((err: unknown) => {
          logger.warn({ err, chatId }, 'sendMessageDraft (stream) failed (non-fatal)');
        });
        lastSentAt = now;
      }
    }

    const parts = splitAtSentenceBoundary(accumulated);
    for (const part of parts) {
      await telegram.sendMessage(managerBotToken, chatId, toTelegramMarkdownV2(part), { parse_mode: 'MarkdownV2' });
    }

    logger.debug({ chatId, userId }, 'processManagerMessage: reply sent');
  } catch (err) {
    logger.error({ err, chatId, userId }, 'processManagerMessage: error');
    try {
      await telegram.sendMessage(
        managerBotToken,
        chatId,
        'Sorry, I encountered an issue. Please try again in a moment.',
      );
    } catch (sendErr) {
      logger.error({ err: sendErr, chatId }, 'processManagerMessage: failed to send error fallback');
    }
  }
}

/**
 * @deprecated Use enqueueManagerMessage instead.
 * Kept as alias so existing callers compile without changes during migration.
 */
export async function handleManagerBotMessage(
  message: Message,
  telegram: TelegramClient,
  agentService: AgentService,
  managerBotToken: string,
  managerBotId: string,
  baseUrl: string,
  botUsername: string,
): Promise<void> {
  // For backward compatibility in tests: call processManagerMessage directly
  // (bypasses queue — used by existing tests that pass agentService directly).
  const from = message.from;
  if (!from) {
    logger.info({ chatId: message.chat.id }, 'handleManagerBotMessage: no from field, ignoring');
    return;
  }

  const conversationId = `manager:${from.id}`;

  // Per-conversation throttle — fail-open: Redis errors allow the message through
  if (env.MANAGER_THROTTLE_MS > 0) {
    logger.warn({ userId: from.id, throttleMs: env.MANAGER_THROTTLE_MS }, 'handleManagerBotMessage: checking throttle');
    try {
      const throttle = await checkThrottle(conversationId, env.MANAGER_THROTTLE_MS);
      logger.debug({ userId: from.id, throttle }, 'handleManagerBotMessage: throttle check');
      if (!throttle.allowed) {
        const seconds = Math.ceil(throttle.retryAfterMs / 1000);
        await telegram.sendMessage(
          managerBotToken,
          message.chat.id,
          `Please wait ${seconds} second${seconds !== 1 ? 's' : ''} before sending another message.`,
        );
        return;
      }
    } catch (err) {
      logger.warn({ err, userId: from.id }, 'handleManagerBotMessage: throttle check failed, proceeding');
    }
  }

  const jobData: ManagerMessageJobData = {
    conversationId,
    userId: from.id,
    chatId: message.chat.id,
    messageId: message.message_id,
    text: message.text ?? '',
    firstName: from.first_name ?? '',
    username: from.username,
  };

  await processManagerMessage(jobData, telegram, agentService, managerBotToken, managerBotId, baseUrl, botUsername);
}
