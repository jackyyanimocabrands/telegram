import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  upsertConversation,
  updateConversationMessages,
  type ConversationRow,
} from '../db/queries/conversations.js';
import type { LlmMessage } from './llm/provider.js';

const VALID_ROLES = new Set(['system', 'user', 'assistant']);

export interface AssembleResult {
  messages: LlmMessage[];
  summaryInjected: boolean;
}

export class ConversationService {
  /**
   * Load (or create with defaults) the conversation row for a given bot + user pair.
   */
  async load(botId: string, telegramUserId: number): Promise<ConversationRow> {
    logger.debug({ botId, telegramUserId }, 'ConversationService.load');
    return upsertConversation(botId, telegramUserId, {
      llmProvider: env.DEFAULT_LLM_PROVIDER,
      llmModel: env.DEFAULT_LLM_MODEL,
      summarizationProvider: env.DEFAULT_SUMMARIZATION_PROVIDER,
      summarizationModel: env.DEFAULT_SUMMARIZATION_MODEL,
    });
  }

  /**
   * Pure function — no DB calls, no async.
   *
   * Assembles the message list to send to the LLM in the following order:
   *   [system?] + [summaryMsg?] + [...row.messages] + [new user message]
   *
   * System prompt: use `systemPromptOverride` if provided, else `row.system_prompt`, else omit.
   * Summary: if `row.summary` is non-null and non-empty, inject as role:'assistant'.
   *
   * Returns the message array and a `summaryInjected` flag so callers can strip
   * the injected summary message before persisting history.
   */
  assemble(
    row: ConversationRow,
    newUserMessage: string,
    systemPromptOverride?: string,
  ): AssembleResult {
    const messages: LlmMessage[] = [];

    // 1. System prompt
    const systemPrompt = systemPromptOverride ?? row.system_prompt ?? null;
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // 2. Summary injection (between system and stored history)
    let summaryInjected = false;
    if (row.summary !== null && row.summary !== '') {
      messages.push({
        role: 'assistant',
        content: `Previous conversation summary: ${row.summary}`,
      });
      summaryInjected = true;
    }

    // 3. Stored conversation history — parse don't cast
    const invalidCount = row.messages.filter(msg => !VALID_ROLES.has(msg.role)).length;
    if (invalidCount > 0) {
      logger.warn(
        { botId: row.bot_id, telegramUserId: row.telegram_user_id, invalidCount },
        'ConversationService.assemble: filtering messages with invalid roles',
      );
    }
    for (const msg of row.messages) {
      if (!VALID_ROLES.has(msg.role)) continue;
      messages.push({ role: msg.role as LlmMessage['role'], content: String(msg.content) });
    }

    // 4. New user message
    messages.push({ role: 'user', content: newUserMessage });

    return { messages, summaryInjected };
  }

  /**
   * Persist the full message history (including the new user turn and assistant reply)
   * back to the database.
   */
  async save(
    botId: string,
    telegramUserId: number,
    allMessages: LlmMessage[],
    summary: string | null,
  ): Promise<void> {
    logger.debug({ botId, telegramUserId, messageCount: allMessages.length }, 'ConversationService.save');
    await updateConversationMessages(botId, telegramUserId, allMessages, summary);
  }
}
