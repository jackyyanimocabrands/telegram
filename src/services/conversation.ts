import { HumanMessage, AIMessage, SystemMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
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

/** Pre-compiled regex for validating tool_call_id values (P8). Avoids recompilation on every fromBaseMessages call. */
const TOOL_CALL_ID_RE = /^[a-zA-Z0-9_\-]+$/;

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
      case 'tool_call': {
        // P7: validate JSON parse
        let rawCalls: unknown;
        try {
          rawCalls = JSON.parse(m.content);
        } catch {
          logger.warn({ content: m.content }, 'toBaseMessages: tool_call content is not valid JSON, using empty tool_calls');
          rawCalls = [];
        }
        // Validate it's an array; each element must have name (non-empty string) and args (plain object)
        const toolCalls: ToolCall[] = Array.isArray(rawCalls)
          ? (rawCalls as unknown[]).filter((tc): tc is ToolCall => {
              if (typeof tc !== 'object' || tc === null) return false;
              const entry = tc as Record<string, unknown>;
              return (
                typeof entry['name'] === 'string' && entry['name'].length > 0 && entry['name'].length <= 64 &&
                typeof entry['args'] === 'object' && entry['args'] !== null && !Array.isArray(entry['args']) &&
                JSON.stringify(entry['args']).length <= 8192
              );
            })
          : [];
        // P6: restore text content from additional_kwargs.text_content
        const restoredContent = (m.additional_kwargs?.text_content as string | undefined) ?? '';
        return new AIMessage({
          content: restoredContent,
          tool_calls: toolCalls,
          id: m.additional_kwargs?.id as string | undefined,
        });
      }
      case 'tool_result':
        return new ToolMessage({ content: m.content, tool_call_id: (m.additional_kwargs?.tool_call_id as string) ?? '' });
      default:          return new HumanMessage(m.content); // safe fallback
    }
  });
}

/**
 * Convert LangChain BaseMessage[] → ConversationMessage[] (DB format).
 * Handles tool_call and tool_result turns. Skips 'remove' and 'function' types.
 */
export function fromBaseMessages(messages: BaseMessage[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];

  for (const m of messages) {
    const type = m.getType();

    if (type === 'remove' || type === 'function') continue;

    if (type === 'system') {
      result.push({ role: 'system', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      continue;
    }

    if (type === 'human') {
      result.push({ role: 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      continue;
    }

    if (type === 'ai') {
      const ai = m as AIMessage;
      if (ai.tool_calls && ai.tool_calls.length > 0) {
        // P5: only persist id when it is a non-empty string
        const idKwarg = ai.id ? { id: ai.id } : undefined;
        // P6: store text content inside the tool_call record to avoid round-trip loss
        const textContent = typeof ai.content === 'string' ? ai.content : JSON.stringify(ai.content);
        const textKwarg = textContent.length > 0 ? { text_content: textContent } : undefined;
        const additional_kwargs = (idKwarg || textKwarg)
          ? { ...idKwarg, ...textKwarg }
          : undefined;
        result.push({
          role: 'tool_call',
          content: JSON.stringify(ai.tool_calls),
          ...(additional_kwargs !== undefined ? { additional_kwargs } : {}),
        });
      } else {
        const textContent = typeof ai.content === 'string' ? ai.content : JSON.stringify(ai.content);
        // P9: allowlist — only persist known-safe scalar keys
        const ASSISTANT_KWARGS_ALLOWLIST = new Set(['id', 'model', 'finish_reason']);
        const filteredKwargs = Object.fromEntries(
          Object.entries(ai.additional_kwargs ?? {}).filter(([k]) => ASSISTANT_KWARGS_ALLOWLIST.has(k)),
        );
        const record: ConversationMessage = { role: 'assistant', content: textContent };
        if (Object.keys(filteredKwargs).length > 0) {
          record.additional_kwargs = filteredKwargs;
        }
        result.push(record);
      }
      continue;
    }

    if (type === 'tool') {
      const tool = m as ToolMessage;
      const rawId = tool.tool_call_id ?? '';
      // P8: validate tool_call_id format — must be a non-empty string, ≤128 chars, safe chars only
      const safeId =
        typeof rawId === 'string' &&
        rawId.length > 0 &&
        rawId.length <= 128 &&
        TOOL_CALL_ID_RE.test(rawId)
          ? rawId
          : '';
      if (safeId !== rawId) {
        logger.warn({ rawId }, 'fromBaseMessages: tool_call_id failed validation, using empty string');
      }
      result.push({
        role: 'tool_result',
        content: typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content),
        additional_kwargs: { tool_call_id: safeId },
      });
      continue;
    }

    // Unknown type — skip
  }

  return result;
}
