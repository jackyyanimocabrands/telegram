CREATE TABLE email_verification_tokens (
  jti          UUID        PRIMARY KEY,
  email        TEXT        NOT NULL,
  bot_id       TEXT        NOT NULL,
  user_id      BIGINT      NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'verified', 'notified')),
  expires_at   TIMESTAMPTZ NOT NULL,
  verified_at  TIMESTAMPTZ,
  notified_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Note: this index is superseded and replaced by migrations/005_email_verification_tokens_index.sql
CREATE INDEX idx_email_verification_tokens_lookup
  ON email_verification_tokens (bot_id, user_id, status);
