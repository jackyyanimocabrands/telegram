import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import {
  upsertConversation,
  updateConversationMessages,
  updateConversationProvider,
  type ConversationRow,
} from '../db/queries/conversations.js';
import type { ConversationMessage } from '../types/conversation.js';

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
   * Persist the full message history (including the new user turn and assistant reply)
   * back to the database.
   */
  async save(
    botId: string,
    telegramUserId: number,
    allMessages: ConversationMessage[],
    summary: string | null,
  ): Promise<void> {
    logger.debug({ botId, telegramUserId, messageCount: allMessages.length }, 'ConversationService.save');
    await updateConversationMessages(botId, telegramUserId, allMessages, summary);
  }

  /**
   * Clear all messages and summary for a bot+user pair.
   */
  async clearMessages(botId: string, telegramUserId: number): Promise<void> {
    logger.debug({ botId, telegramUserId }, 'ConversationService.clearMessages');
    await updateConversationMessages(botId, telegramUserId, [], null);
  }

  /**
   * Update the LLM provider and model for a bot+user pair.
   */
  async updateProvider(
    botId: string,
    telegramUserId: number,
    provider: string,
    model: string,
  ): Promise<void> {
    logger.debug({ botId, telegramUserId, provider, model }, 'ConversationService.updateProvider');
    await updateConversationProvider(botId, telegramUserId, provider, model);
  }
}

// ── LangChain message converters ───────────────────────────────────────────

/**
 * Convert ConversationMessage[] (DB format) → LangChain BaseMessage[].
 */
export function toBaseMessages(messages: ConversationMessage[]): BaseMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'user':      return new HumanMessage(m.content);
      case 'assistant': return new AIMessage(m.content);
      case 'system':    return new SystemMessage(m.content);
      default:          return new HumanMessage(m.content); // safe fallback
    }
  });
}

/**
 * Convert LangChain BaseMessage[] → ConversationMessage[] (DB format).
 * Filters out 'remove' type messages.
 */
export function fromBaseMessages(messages: BaseMessage[]): ConversationMessage[] {
  return messages
    .filter(m => !['remove', 'tool', 'function'].includes(m.getType()))
    .map((m) => {
      const type = m.getType();
      let role: 'user' | 'assistant' | 'system';
      if (type === 'human') role = 'user';
      else if (type === 'ai') role = 'assistant';
      else if (type === 'system') role = 'system';
      else role = 'user'; // fallback for tool/function messages
      return {
        role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
    });
}
