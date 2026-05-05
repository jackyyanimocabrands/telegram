-- Migration 008: replace boolean processed column with status enum
-- Three valid states: PENDING (just inserted), PROCESSED (success), FAILED (error)

BEGIN;

-- Add the new status column with a CHECK constraint
ALTER TABLE webhook_event_log
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED'));

-- Backfill from existing processed + error columns
UPDATE webhook_event_log SET status = 'PROCESSED' WHERE processed = true;
UPDATE webhook_event_log SET status = 'FAILED'    WHERE processed = false AND error IS NOT NULL;
-- Rows with processed=false AND error IS NULL remain 'PENDING' (already the default)

-- Drop the old column
ALTER TABLE webhook_event_log DROP COLUMN IF EXISTS processed;

COMMIT;
