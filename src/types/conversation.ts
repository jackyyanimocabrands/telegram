/**
 * Minimal chat message shape shared between the DB layer and the LLM service layer.
 * Defined here to avoid a circular dependency between src/db/queries and src/services/llm.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result';
  content: string;
  additional_kwargs?: Record<string, unknown>;
}
