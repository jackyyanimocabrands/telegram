import { pool } from '../client.js';
import { logger } from '../../utils/logger.js';
import type { WebhookEventLogRow } from '../../types/api.js';

/**
 * Atomic dedup gate. INSERT ... ON CONFLICT DO NOTHING — if rowCount > 0,
 * we acquired the update and can proceed. If 0, another thread already has it.
 * This eliminates the TOCTOU race between check and insert.
 */
export async function tryAcquireUpdate(
  botId: number,
  updateId: number,
  eventType: string,
  payload: unknown,
): Promise<WebhookEventLogRow | null> {
  const result = await pool.query<WebhookEventLogRow>(
    `INSERT INTO webhook_event_log (bot_id, update_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (bot_id, update_id) DO NOTHING
     RETURNING *`,
    [botId, updateId, eventType, JSON.stringify(payload)],
  );
  if (result.rows[0]) {
    logger.debug({ botId, updateId, eventType }, 'tryAcquireUpdate: acquired');
    return result.rows[0];
  }
  logger.info({ botId, updateId }, 'tryAcquireUpdate: duplicate, already acquired by another thread');
  return null;
}

export async function markProcessed(id: number): Promise<void> {
  logger.debug({ id }, 'markProcessed: webhook event marked processed');
  await pool.query('UPDATE webhook_event_log SET processed = true, error = NULL WHERE id = $1', [id]);
}

export async function markFailed(id: number, error: string): Promise<void> {
  logger.warn({ id, error }, 'markFailed: webhook event marked failed — available for retry');
  await pool.query('UPDATE webhook_event_log SET processed = false, error = $1 WHERE id = $2', [error, id]);
}
