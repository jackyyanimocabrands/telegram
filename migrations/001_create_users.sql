CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  telegram_id     BIGINT       NOT NULL UNIQUE,
  first_name      TEXT         NOT NULL,
  last_name       TEXT,
  username        TEXT,
  photo_url       TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_telegram_id ON users (telegram_id);
