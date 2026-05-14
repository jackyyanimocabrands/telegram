DROP INDEX IF EXISTS idx_email_verification_tokens_lookup;
CREATE INDEX idx_email_verification_tokens_lookup
  ON email_verification_tokens (bot_id, user_id, status, expires_at DESC, created_at DESC);
