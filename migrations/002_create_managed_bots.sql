CREATE TYPE managed_bot_status AS ENUM (
  'PENDING',
  'PROVISIONING',
  'ACTIVE',
  'TOKEN_ROTATED',
  'DEACTIVATED'
);

CREATE TABLE IF NOT EXISTS managed_bots (
  id                    SERIAL PRIMARY KEY,
  bot_id                BIGINT               NOT NULL UNIQUE,
  bot_username          TEXT,
  owner_telegram_id     BIGINT               NOT NULL,
  owner_user_id         INTEGER              NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_token       BYTEA                NOT NULL,
  token_iv              BYTEA                NOT NULL,
  token_key_version     INTEGER              NOT NULL DEFAULT 1,
  status                managed_bot_status   NOT NULL DEFAULT 'PENDING',
  webhook_set           BOOLEAN              NOT NULL DEFAULT false,
  profile_set           BOOLEAN              NOT NULL DEFAULT false,
  commands_set          BOOLEAN              NOT NULL DEFAULT false,
  last_token_rotated    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ          NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ          NOT NULL DEFAULT now()
);
CREATE INDEX idx_managed_bots_owner_telegram_id ON managed_bots (owner_telegram_id);
CREATE INDEX idx_managed_bots_bot_id ON managed_bots (bot_id);
CREATE INDEX idx_managed_bots_status ON managed_bots (status);
