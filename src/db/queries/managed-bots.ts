import { pool } from '../client.js';
import { logger } from '../../utils/logger.js';
import { ConflictError } from '../../utils/errors.js';
import type { ManagedBotRow, ManagedBotStatus } from '../../types/api.js';

export async function upsertManagedBot(data: {
  botId: number;
  botUsername?: string;
  ownerTelegramId: number;
  ownerUserId: number;
  encryptedToken: Buffer;
  tokenIv: Buffer;
  tokenKeyVersion: number;
  status: ManagedBotStatus;
  webhookSecret: string;
}): Promise<ManagedBotRow> {
  logger.debug({ botId: data.botId, status: data.status, ownerTelegramId: data.ownerTelegramId }, 'upsertManagedBot');
  const result = await pool.query<ManagedBotRow>(
    `INSERT INTO managed_bots (bot_id, bot_username, owner_telegram_id, owner_user_id, encrypted_token, token_iv, token_key_version, status, webhook_secret)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (bot_id)
     DO UPDATE SET
       bot_username       = EXCLUDED.bot_username,
       owner_telegram_id  = EXCLUDED.owner_telegram_id,
       owner_user_id      = EXCLUDED.owner_user_id,
       encrypted_token    = EXCLUDED.encrypted_token,
       token_iv           = EXCLUDED.token_iv,
       token_key_version  = EXCLUDED.token_key_version,
       status             = EXCLUDED.status,
       webhook_secret     = EXCLUDED.webhook_secret,
       updated_at         = now()
     WHERE managed_bots.owner_telegram_id = EXCLUDED.owner_telegram_id
     RETURNING *`,
    [data.botId, data.botUsername ?? null, data.ownerTelegramId, data.ownerUserId, data.encryptedToken, data.tokenIv, data.tokenKeyVersion, data.status, data.webhookSecret],
  );

  // M-09: If rowCount is 0, the row exists but belongs to a different owner — reject the upsert.
  if ((result.rowCount ?? 0) === 0) {
    const existing = await pool.query<{ owner_telegram_id: number }>(
      'SELECT owner_telegram_id FROM managed_bots WHERE bot_id = $1',
      [data.botId],
    );
    if (existing.rows.length > 0 && existing.rows[0]!.owner_telegram_id !== data.ownerTelegramId) {
      throw new ConflictError('Bot is already registered to another user');
    }
    // If still 0 rows somehow, re-query and return (defensive path)
    const refetch = await pool.query<ManagedBotRow>('SELECT * FROM managed_bots WHERE bot_id = $1', [data.botId]);
    return refetch.rows[0]!;
  }

  logger.debug({ botId: data.botId, status: data.status }, 'upsertManagedBot: done');
  return result.rows[0]!;
}

export async function findManagedBotByBotId(botId: number): Promise<ManagedBotRow | null> {
  const result = await pool.query<ManagedBotRow>(
    'SELECT * FROM managed_bots WHERE bot_id = $1',
    [botId],
  );
  const bot = result.rows[0] ?? null;
  if (!bot) {
    logger.debug({ botId }, 'findManagedBotByBotId: not found');
  }
  return bot;
}

export async function findManagedBotByOwnerTelegramId(
  ownerTelegramId: number,
): Promise<ManagedBotRow | null> {
  const result = await pool.query<ManagedBotRow>(
    'SELECT * FROM managed_bots WHERE owner_telegram_id = $1 ORDER BY created_at DESC LIMIT 1',
    [ownerTelegramId],
  );
  const bot = result.rows[0] ?? null;
  if (!bot) {
    logger.debug({ ownerTelegramId }, 'findManagedBotByOwnerTelegramId: not found');
  }
  return bot;
}

export async function updateManagedBotStatus(botId: number, status: ManagedBotStatus): Promise<void> {
  logger.debug({ botId, status }, 'updateManagedBotStatus');
  await pool.query(
    'UPDATE managed_bots SET status = $1, updated_at = now() WHERE bot_id = $2',
    [status, botId],
  );
}

/** Atomic activation — sets status to ACTIVE and all provisioning flags in one write. */
export async function activateManagedBot(botId: number, updateMode?: string): Promise<void> {
  logger.debug({ botId, updateMode }, 'activateManagedBot: setting ACTIVE with all flags');
  await pool.query(
    `UPDATE managed_bots
     SET status = 'ACTIVE',
         webhook_set = true,
         profile_set = true,
         commands_set = true,
         update_mode = COALESCE($2, update_mode),
         updated_at = now()
     WHERE bot_id = $1`,
    [botId, updateMode ?? null],
  );
}

export async function updateManagedBotToken(botId: number,
  encryptedToken: Buffer,
  tokenIv: Buffer,
  keyVersion: number,
): Promise<void> {
  logger.debug({ botId, keyVersion }, 'updateManagedBotToken');
  await pool.query(
    `UPDATE managed_bots
     SET encrypted_token = $1, token_iv = $2, token_key_version = $3,
         last_token_rotated = now(), updated_at = now()
     WHERE bot_id = $4`,
    [encryptedToken, tokenIv, keyVersion, botId],
  );
}

/** Load all ACTIVE bots for registry startup. */
export async function findAllActiveManagedBots(): Promise<ManagedBotRow[]> {
  logger.debug('findAllActiveManagedBots');
  const result = await pool.query<ManagedBotRow>(
    "SELECT * FROM managed_bots WHERE status = 'ACTIVE'",
  );
  return result.rows;
}

/** Persist polling offset after processing an update. */
export async function savePollingOffset(botId: number, offset: number): Promise<void> {
  logger.debug({ botId, offset }, 'savePollingOffset');
  await pool.query(
    'UPDATE managed_bots SET polling_offset = $1, updated_at = now() WHERE bot_id = $2',
    [offset, botId],
  );
}

/**
 * Fetch the per-bot webhook secret for a given bot.
 * Returns null if the bot is not found, not ACTIVE, or has no secret set.
 */
export async function getBotWebhookSecret(botId: number): Promise<string | null> {
  logger.debug({ botId }, 'getBotWebhookSecret');
  const result = await pool.query<{ webhook_secret: string | null }>(
    "SELECT webhook_secret FROM managed_bots WHERE bot_id = $1 AND status = 'ACTIVE'",
    [botId],
  );
  return result.rows[0]?.webhook_secret ?? null;
}
