-- Token usage tracking
CREATE TABLE token_usage (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id            TEXT        NOT NULL,
  telegram_user_id  BIGINT      NOT NULL,
  provider          TEXT        NOT NULL,
  model             TEXT        NOT NULL,
  usage_type        TEXT        NOT NULL CHECK (usage_type IN ('chat', 'summarization')),
  input_tokens      INTEGER     NOT NULL DEFAULT 0,
  output_tokens     INTEGER     NOT NULL DEFAULT 0,
  total_tokens      INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_token_usage_bot_user    ON token_usage (bot_id, telegram_user_id);
CREATE INDEX idx_token_usage_model       ON token_usage (provider, model);
CREATE INDEX idx_token_usage_created_at  ON token_usage (created_at);
CREATE INDEX idx_token_usage_bot_created ON token_usage (bot_id, created_at DESC);
CREATE INDEX idx_token_usage_model_created ON token_usage (provider, model, created_at);
