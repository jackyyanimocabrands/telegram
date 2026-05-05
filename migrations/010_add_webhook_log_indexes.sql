-- Partial index for PENDING/FAILED status lookups (retry workers, monitoring queries)
CREATE INDEX IF NOT EXISTS idx_webhook_event_log_status
  ON webhook_event_log (status)
  WHERE status IN ('PENDING', 'FAILED');

-- Index for time-based retention/cleanup queries
CREATE INDEX IF NOT EXISTS idx_webhook_event_log_created_at
  ON webhook_event_log (created_at);
