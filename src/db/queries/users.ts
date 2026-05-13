import { pool } from '../client.js';
import { logger } from '../../utils/logger.js';
import type { UserRow } from '../../types/api.js';

export async function upsertUser(data: {
  telegramId: number;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
}): Promise<UserRow> {
  logger.debug({ telegramId: data.telegramId, username: data.username }, 'upsertUser');
  const result = await pool.query<UserRow>(
    `INSERT INTO users (telegram_id, first_name, last_name, username, photo_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telegram_id)
     DO UPDATE SET
       first_name  = EXCLUDED.first_name,
       last_name   = EXCLUDED.last_name,
       username    = EXCLUDED.username,
       photo_url   = EXCLUDED.photo_url,
       updated_at  = now()
     RETURNING *`,
    [data.telegramId, data.firstName, data.lastName ?? null, data.username ?? null, data.photoUrl ?? null],
  );
  logger.debug({ telegramId: data.telegramId, userId: result.rows[0]?.id }, 'upsertUser: done');
  return result.rows[0]!;
}

export async function findUserByTelegramId(telegramId: number): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    'SELECT * FROM users WHERE telegram_id = $1',
    [telegramId],
  );
  const user = result.rows[0] ?? null;
  if (!user) {
    logger.debug({ telegramId }, 'findUserByTelegramId: not found');
  }
  return user;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );
  const user = result.rows[0] ?? null;
  if (!user) {
    logger.debug({ id }, 'findUserById: not found');
  }
  return user;
}
