-- 003_tool_system.sql
-- Add toolset_state to conversations for per-user tool tier persistence

-- Add toolset_state to conversations for per-user tool tier persistence
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS toolset_state JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Index for fast lookup of verified users
CREATE INDEX IF NOT EXISTS idx_conversations_toolset_email_verified
  ON conversations ((toolset_state->>'email_verified'))
  WHERE toolset_state->>'email_verified' = 'true';
