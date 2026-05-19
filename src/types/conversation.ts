/**
 * Minimal chat message shape shared between the DB layer and the LLM service layer.
 * Defined here to avoid a circular dependency between src/db/queries and src/services/llm.
 */
export interface ConversationMessage {
  role: string;
  content: string;
  additional_kwargs?: Record<string, unknown>;
}
