import { logger } from '../utils/logger.js';
import { findManagedBotByOwner } from '../db/queries/managed-bots.js';
import { getToolsetState } from '../db/queries/conversations.js';
import { env } from '../config/env.js';
import { interpolate } from '../utils/interpolate.js';
import type { TelegramClient } from './telegram-api.js';
import type { AgentService } from './agent.js';
import type { Message } from '../types/telegram.js';
import { toTelegramMarkdownV2 } from '../utils/telegram-markdownv2.js';
import { checkThrottle } from './conversation-throttle.js';
import { acquireLock, releaseLock } from './conversation-lock.js';
import { managerQueue as defaultManagerQueue } from '../queues/manager-queue.js';
import { resolveToolTier, getToolsForTier } from './tool-tier.js';
import { MIND_USE_CASE_VALUES } from './tools/save-mind-context.js';
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
  _botUsername: string,
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
        languageCode: from.language_code,
      },
      { jobId: `msg-${message.message_id}` },
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
  const { chatId, userId, text, firstName, conversationId, languageCode } = jobData;

  logger.info({ chatId, userId, conversationId }, 'processManagerMessage: start');

  const safeName = (firstName ?? 'there')
    .replace(/[^a-zA-Z0-9 \-']/g, '')
    .slice(0, 50)
    .trim() || 'there';

  try {
    const [managedBot, toolsetStateResult] = await Promise.all([
      findManagedBotByOwner(userId),
      getToolsetState(managerBotId, userId).catch((err) => {
        logger.warn({ err, botId: managerBotId, userId }, 'processManagerMessage: failed to load toolset state, proceeding with base tier');
        return {} as Record<string, unknown>;
      }),
    ]);

    // PII WARNING: toolsetState may contain email and email_verified.
    // Do NOT log this object. Only projected fields (timezone, locale) are forwarded to plugins.
    let toolsetState: Record<string, unknown> = toolsetStateResult;

    // Always use the Telegram-supplied language_code as locale — no DB storage needed.
    if (languageCode) {
      toolsetState = { ...toolsetState, locale: languageCode };
    }

    // Resolve tool tier for this user and load the appropriate tools
    // B5: downgrade to base if authenticated tier but email is absent/empty
    let tier = resolveToolTier(toolsetState);
    if (tier === 'authenticated' && (typeof toolsetState.email !== 'string' || toolsetState.email.length === 0)) {
      logger.warn({ botId: managerBotId, userId }, 'processManagerMessage: authenticated tier but no email — downgrading to base');
      tier = 'base';
    }
    const tools = getToolsForTier(tier, {
      userEmail: typeof toolsetState.email === 'string' ? toolsetState.email : '',
      botId: managerBotId,
      userId: String(userId),
    });

    logger.debug({ userId, toolTier: tier, toolCount: tools.length }, 'processManagerMessage: tool tier resolved');

    // Extract pending_use_case for authenticated prompt — validate against allowlist at read time
    const rawPendingUseCase = toolsetState.pending_use_case;
    const pendingUseCase = typeof rawPendingUseCase === 'string' &&
      (MIND_USE_CASE_VALUES as readonly string[]).includes(rawPendingUseCase)
      ? rawPendingUseCase
      : '';

    let systemPrompt: string;

    if (tier === 'authenticated') {
      const safeUsername = managedBot?.bot_username && TELEGRAM_USERNAME_RE.test(managedBot.bot_username)
        ? managedBot.bot_username
        : '';
      let botContext: string;
      if (managedBot?.status === 'ACTIVE') {
        botContext = `Their Mind @${safeUsername} is live and handling their general conversations.`;
      } else if (managedBot?.status === 'PENDING' || managedBot?.status === 'PROVISIONING') {
        botContext = `Their Mind is currently being set up — it will be ready shortly.`;
      } else {
        botContext = '';
      }

      const template =
        (env.MANAGER_SETTINGS_PROMPT && env.MANAGER_SETTINGS_PROMPT.trim()) ||
        `You are a friendly helpful general assistant for HelloMinds, here to help {name}.
The user has just verified their email — Mind creation is now unlocked.
{botContext}
On the very first message the user sends after verification, proactively acknowledge their verified email and immediately offer to start creating their Mind — do not wait for them to bring it up.
If the message is "[email_verified]", this is an automated system signal — do not mention or explain it. Greet the user warmly, acknowledge their email is verified, and immediately begin Mind creation from the appropriate step.
{pendingUseCase}

You can still help with everyday tasks: answering questions, searching the web, looking things up. Use the web_search and web_fetch tools when needed.
When a task is too complex for a general assistant — something that needs research, statistical analysis, memory, autonomy, ongoing work, or specialised capability — suggest that the user creates their own Mind.
Always recommend a Mind for follow-up actions, ongoing work, or anything that needs memory or specialised capability. Be proactive in suggesting it.
If a task is beyond your capability, never decline outright — position it as something their Mind is built for and offer to create one right now.
When a complex task comes up, say something like: "This sounds like something a dedicated Mind could handle much better — and since you're verified, we can create one right now. Want to go ahead?"
When the user agrees to create a Mind, focus only on the specific use case they just decided on — do not list or reference other topics discussed earlier in the conversation.

MIND CREATION — unlocked:
A Mind is a personal AI agent with its own identity, persistent memory, and the ability to act on the user's behalf.
When the user is ready to create a Mind, guide them through the steps below — one at a time. If the conversation already establishes what they want to build or what name to use, pick up from the relevant step. Do not restart from Step 1 if earlier context makes it unnecessary.

STEP 1 — Choose a use case (skip if already clear from context)
Help the user decide what their Mind should do. Use these as a starting point:
- General Assistant: everyday tasks, Q&A, productivity
- Research: deep research, summarisation, analysis
- Customer Support: answering questions, handling requests
- Coding: writing, reviewing, and debugging code
- Writing: drafting, editing, creative and professional writing

STEP 2 — Name the Mind (skip if already decided)
Suggest 3 creative names relevant to the chosen use case. For each name, call check_bot_username to confirm it is available before suggesting it. Only suggest available names.
Usernames must end in _bot, be 5–32 characters, alphanumeric and underscores only.
Wait for the user to choose or propose a name. Verify any user-proposed name with check_bot_username before accepting it.

STEP 3 — Create the Mind
Once a name is confirmed, send the user this deep link:
https://t.me/newbot/{managerBotUsername}/<confirmed_username>?name=<confirmed_display_name>
Replace <confirmed_username> with the agreed bot username and <confirmed_display_name> with the agreed display name (URL-encode spaces as %20).
Tell the user to tap it and confirm — one tap is all it takes. Their Mind will be created automatically.
Do not ask for a token. Do not mention BotFather.

Keep all replies short and conversational. Politely decline anything unrelated to HelloMinds or general assistance.`;

      const pendingUseCaseBlock = pendingUseCase
        ? `The user's confirmed use case is: ${pendingUseCase}. Skip Step 1 — go directly to Step 2 and suggest 3 available Mind names for a ${pendingUseCase} Mind.`
        : '';

      systemPrompt = interpolate(template, { name: safeName, botContext, botUsername: safeUsername, managerBotUsername: botUsername, pendingUseCase: pendingUseCaseBlock });
    } else {
      const template =
        (env.MANAGER_ONBOARDING_PROMPT && env.MANAGER_ONBOARDING_PROMPT.trim()) ||
        `You are a friendly helpful general assistant for HelloMinds, here to help {name}.
Start by asking what you can help them with today. 
When a task is too complex for a general assistant — something that needs research, statistical analysis, memory, autonomy, ongoing work, or specialised capability — suggest that the user creates their own Mind.
Always recommend the user to create a Mind for follow up actions, ongoing work, or anything that needs memory or specialised capability.
Always be proactive in suggesting additional help. If a task is beyond your capability, never decline outright — position it as something their Mind is built for and offer to create one.
You can handle simple tasks: answering questions, looking things up, searching the web. Use the web_search and web_fetch tools when needed.
A Mind is a personal AI agent with its own identity, persistent memory, and the ability to act on the user's behalf. It takes under 60 seconds to create.
When a complex task comes up, say something like: "This sounds like something a dedicated Mind could handle much better. Would you like to create one? It only takes 60 seconds — I just need your email to get started."
When the user agrees to create a Mind, focus only on the specific use case they just decided on — do not list or reference other topics discussed earlier in the conversation.
Once the user confirms their use case, immediately call save_mind_context to record it, then ask for their email.
Once the user provides their email, call the verify_email tool immediately — do not describe what you are about to do, just call it.
RULE: You may only confirm an email was sent if verify_email returned a success message in this exact response. A tool call from a prior turn does not count — you must call it again.
RULE: When the user asks to resend or says they did not receive it, call verify_email right now in this response. Do not say the email was sent without an active tool call. Generating a confirmation without calling the tool is a hallucination.
Keep all replies short and conversational. Politely decline anything unrelated to HelloMinds or general assistance.`;
      systemPrompt = interpolate(template, { name: safeName });
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

    const draftId = Math.floor(Date.now() + Math.random() * 1000);
    setTimeout(() => {
      telegram.sendMessageDraft(managerBotToken, chatId, draftId, 'Thinking').catch((err: unknown) => {
        logger.warn({ err, chatId }, 'sendMessageDraft (thinking) failed (non-fatal)');
      });
    }, 250);

    let accumulated = '';
    let lastSentAt = 0;
    const throttleMs = env.STREAM_THROTTLE_MS;
    
    for await (const chunk of agentService.chatStream(managerBotId, userId, text, systemPrompt, tools, toolsetState)) {
      accumulated += chunk;
      const now = Date.now();
      await tryTyping();
      if (throttleMs === 0 || now - lastSentAt >= throttleMs) {
        await telegram.sendMessageDraft(managerBotToken, chatId, draftId, toTelegramMarkdownV2(accumulated), 'MarkdownV2')
        .catch((err: unknown) => {
          logger.warn({ err, chatId }, 'sendMessageDraft (stream) failed (non-fatal)');
        });
        lastSentAt = now;
      }
    }
    logger.debug({ chatId, message: toTelegramMarkdownV2(accumulated) }, 'processManagerMessage: stream ended');
    await telegram.sendMessage(managerBotToken, chatId, toTelegramMarkdownV2(accumulated), { parse_mode: 'MarkdownV2' });

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
