CREATE TABLE IF NOT EXISTS conversations (
  id                      SERIAL PRIMARY KEY,
  bot_id                  TEXT NOT NULL,
  telegram_user_id        BIGINT NOT NULL,
  llm_provider            TEXT NOT NULL DEFAULT 'openai',
  llm_model               TEXT NOT NULL DEFAULT 'gpt-4o',
  summarization_provider  TEXT NOT NULL DEFAULT 'openai',
  summarization_model     TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  messages                JSONB NOT NULL DEFAULT '[]',
  summary                 TEXT,
  system_prompt           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bot_id, telegram_user_id)
  -- The UNIQUE constraint above implicitly creates a B-tree index on (bot_id, telegram_user_id).
  -- No separate CREATE INDEX is needed — it would be redundant and double write amplification.
);
