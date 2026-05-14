-- 001_init.sql
-- Consolidated initial schema. Replaces migrations 001–012.
-- Pre-launch — single clean schema with UUID PKs, no FK constraints.

-- ── clean slate ────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS webhook_event_log;
DROP TABLE IF EXISTS managed_bots;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS app_state;
DROP TYPE  IF EXISTS managed_bot_status;

-- ── types ──────────────────────────────────────────────────────────────────
CREATE TYPE managed_bot_status AS ENUM (
  'PENDING',
  'PROVISIONING',
  'ACTIVE',
  'TOKEN_ROTATED',
  'DEACTIVATED'
);

-- ── users ──────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     BIGINT       NOT NULL UNIQUE,
  first_name      TEXT         NOT NULL,
  last_name       TEXT,
  username        TEXT,
  photo_url       TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_telegram_id ON users (telegram_id);

-- ── managed_bots ───────────────────────────────────────────────────────────
CREATE TABLE managed_bots (
  id                          UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id                      BIGINT               NOT NULL UNIQUE,
  bot_username                TEXT,
  owner_telegram_id           BIGINT               NOT NULL,
  owner_user_id               TEXT                 NOT NULL,  -- UUID stored as TEXT, no FK
  encrypted_token             BYTEA                NOT NULL,
  token_iv                    BYTEA                NOT NULL,
  token_key_version           INTEGER              NOT NULL DEFAULT 1,
  status                      managed_bot_status   NOT NULL DEFAULT 'PENDING',
  webhook_set                 BOOLEAN              NOT NULL DEFAULT false,
  profile_set                 BOOLEAN              NOT NULL DEFAULT false,
  commands_set                BOOLEAN              NOT NULL DEFAULT false,
  update_mode                 TEXT                 NOT NULL DEFAULT 'webhook',
  polling_offset              BIGINT               NOT NULL DEFAULT 0,
  webhook_secret              BYTEA,
  webhook_secret_iv           BYTEA,
  webhook_secret_key_version  INTEGER,
  last_token_rotated          TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ          NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ          NOT NULL DEFAULT now()
);
CREATE INDEX idx_managed_bots_owner_telegram_id ON managed_bots (owner_telegram_id);
CREATE INDEX idx_managed_bots_bot_id            ON managed_bots (bot_id);
CREATE INDEX idx_managed_bots_status            ON managed_bots (status);

-- ── webhook_event_log ──────────────────────────────────────────────────────
CREATE TABLE webhook_event_log (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id          BIGINT       NOT NULL,
  update_id       BIGINT       NOT NULL,
  event_type      TEXT         NOT NULL,
  payload         JSONB        NOT NULL,
  status          TEXT         NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
  error           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (bot_id, update_id)
);
CREATE INDEX idx_webhook_event_log_bot_id     ON webhook_event_log (bot_id);
CREATE INDEX idx_webhook_event_log_status     ON webhook_event_log (status)
  WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX idx_webhook_event_log_created_at ON webhook_event_log (created_at);

-- ── app_state ──────────────────────────────────────────────────────────────
CREATE TABLE app_state (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── conversations ──────────────────────────────────────────────────────────
CREATE TABLE conversations (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id                  TEXT         NOT NULL,
  telegram_user_id        BIGINT       NOT NULL,
  llm_provider            TEXT         NOT NULL DEFAULT 'openai',
  llm_model               TEXT         NOT NULL DEFAULT 'gpt-4o',
  summarization_provider  TEXT         NOT NULL DEFAULT 'openai',
  summarization_model     TEXT         NOT NULL DEFAULT 'gpt-4o-mini',
  messages                JSONB        NOT NULL DEFAULT '[]',
  summary                 TEXT,
  system_prompt           TEXT,
  force_summarize         BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (bot_id, telegram_user_id)
  -- The UNIQUE constraint above implicitly creates a B-tree index on (bot_id, telegram_user_id).
);

-- ── token_usage ────────────────────────────────────────────────────────────
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
CREATE INDEX idx_token_usage_bot_created  ON token_usage (bot_id, created_at DESC);
CREATE INDEX idx_token_usage_model_created ON token_usage (provider, model, created_at);
