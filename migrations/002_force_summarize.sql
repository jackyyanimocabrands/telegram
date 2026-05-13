-- Add manual force-summarize toggle to conversations.
-- When set to TRUE by an operator, the next agent turn summarizes the oldest
-- 75% of conversation history regardless of token budget, then resets to FALSE.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS force_summarize BOOLEAN NOT NULL DEFAULT FALSE;
