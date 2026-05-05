-- Migration 007: add per-bot webhook secret
-- Existing rows will have webhook_secret = NULL and fall back to CHILD_WEBHOOK_SECRET env var.
-- New bots provisioned after this migration will have their own generated secret.

ALTER TABLE managed_bots ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
