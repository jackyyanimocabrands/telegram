-- Migration 009: store webhook_secret encrypted (like encrypted_token)
-- Add iv and key_version columns to support AES-256-GCM encryption of webhook_secret.
-- Existing plaintext secrets in webhook_secret are invalidated — bots will regenerate on next provision.

ALTER TABLE managed_bots
  ADD COLUMN IF NOT EXISTS webhook_secret_iv BYTEA,
  ADD COLUMN IF NOT EXISTS webhook_secret_key_version INTEGER;

-- Null out existing plaintext secrets — they will be regenerated at next bot provisioning.
UPDATE managed_bots SET webhook_secret = NULL, webhook_secret_iv = NULL, webhook_secret_key_version = NULL;
