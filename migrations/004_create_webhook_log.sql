CREATE TABLE IF NOT EXISTS webhook_event_log (
  id              SERIAL PRIMARY KEY,
  bot_id          BIGINT       NOT NULL,
  update_id       BIGINT       NOT NULL,
  event_type      TEXT         NOT NULL,
  payload         JSONB        NOT NULL,
  processed       BOOLEAN      NOT NULL DEFAULT false,
  error           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (bot_id, update_id)
);
CREATE INDEX idx_webhook_event_log_bot_id ON webhook_event_log (bot_id);
