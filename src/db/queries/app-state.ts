import { pool } from '../client.js';
import { logger } from '../../utils/logger.js';

export async function getAppState(key: string): Promise<string | null> {
  const result = await pool.query<{ value: string }>(
    'SELECT value FROM app_state WHERE key = $1',
    [key],
  );
  const val = result.rows[0]?.value ?? null;
  logger.debug({ key, found: val !== null }, 'getAppState');
  return val;
}

export async function setAppState(key: string, value: string): Promise<void> {
  logger.debug({ key }, 'setAppState');
  await pool.query(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}
