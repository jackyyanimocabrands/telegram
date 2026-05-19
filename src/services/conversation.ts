import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import { llmConfig } from '../config/llm-config.js';
import { logger } from '../utils/logger.js';
import {
  upsertConversation,
  updateConversationMessages,
  resetForceSummarize,
  type ConversationRow,
} from '../db/queries/conversations.js';
import type { ConversationMessage } from '../types/conversation.js';

export class ConversationService {
  /**
   * Load (or create with initialMetadata) the conversation row for a given bot + user pair.
   * initialMetadata is only written on INSERT — not used for LLM selection;
   * selection is driven by llmConfig at graph runtime.
   */
  async load(botId: string, telegramUserId: number): Promise<ConversationRow> {
    logger.debug({ botId, telegramUserId }, 'ConversationService.load');
    // Only written on INSERT — not used for LLM selection; selection is driven by llmConfig
    const initialMetadata = {
      llmProvider: llmConfig.chat[0]!.provider,
      llmModel: llmConfig.chat[0]!.model,
      summarizationProvider: llmConfig.summarization[0]!.provider,
      summarizationModel: llmConfig.summarization[0]!.model,
    };
    return upsertConversation(botId, telegramUserId, initialMetadata);
  }

  /**
   * Persist the full message history (including the new user turn and assistant reply)
   * back to the database. Optionally merges the provider/model "last used" columns
   * into the same UPDATE to avoid a second round-trip.
   */
  async save(
    botId: string,
    telegramUserId: number,
    allMessages: ConversationMessage[],
    summary: string | null,
    lastUsed?: {
      provider: string;
      model: string;
      summarizationProvider: string;
      summarizationModel: string;
    },
  ): Promise<void> {
    logger.debug({ botId, telegramUserId, messageCount: allMessages.length }, 'ConversationService.save');
    await updateConversationMessages(botId, telegramUserId, allMessages, summary, lastUsed);
  }

  /**
   * Clear all messages and summary for a bot+user pair.
   */
  async clearMessages(botId: string, telegramUserId: number): Promise<void> {
    logger.debug({ botId, telegramUserId }, 'ConversationService.clearMessages');
    await updateConversationMessages(botId, telegramUserId, [], null);
  }

  /**
   * Reset the force_summarize flag to FALSE after a forced summarization completes.
   */
  async resetForceSummarize(botId: string, telegramUserId: number): Promise<void> {
    logger.debug({ botId, telegramUserId }, 'ConversationService.resetForceSummarize');
    await resetForceSummarize(botId, telegramUserId);
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
      case 'assistant': return new AIMessage({
        content: m.content,
        ...(m.additional_kwargs && Object.keys(m.additional_kwargs).length > 0
          ? { additional_kwargs: m.additional_kwargs }
          : {}),
      });
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

      const base = {
        role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };

      if (role === 'assistant') {
        const filteredKwargs = Object.fromEntries(
          Object.entries(m.additional_kwargs ?? {}).filter(([k]) => k !== 'tool_calls'),
        );
        if (Object.keys(filteredKwargs).length > 0) {
          return { ...base, additional_kwargs: filteredKwargs };
        }
      }

      return base;
    });
}
