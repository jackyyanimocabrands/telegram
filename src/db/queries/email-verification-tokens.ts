import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../client.js';
import { logger } from '../../utils/logger.js';

/** Union type accepted by all query helpers — both Pool and PoolClient expose .query() */
type Queryable = Pool | PoolClient;

export interface EmailVerificationTokenRow {
  jti: string;
  email: string;
  bot_id: string;
  user_id: number;
  status: 'pending' | 'verified' | 'notified';
  expires_at: Date;
  verified_at: Date | null;
  notified_at: Date | null;
  created_at: Date;
}

/**
 * Insert a new email verification token row.
 * Throws on conflict (duplicate jti).
 */
export async function insertToken(
  jti: string,
  email: string,
  botId: string,
  userId: number,
  expiresAt: Date,
  pool: Queryable = defaultPool,
): Promise<void> {
  // BLOCKER 5: omit email from log to avoid PII in debug output
  logger.debug({ jti, botId, userId }, 'insertToken');
  await pool.query(
    `INSERT INTO email_verification_tokens (jti, email, bot_id, user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [jti, email, botId, userId, expiresAt],
  );
}

/**
 * Fetch a token row by primary key (jti).
 * Returns null if not found.
 */
export async function getToken(
  jti: string,
  pool: Queryable = defaultPool,
): Promise<EmailVerificationTokenRow | null> {
  logger.debug({ jti }, 'getToken');
  const result = await pool.query<EmailVerificationTokenRow>(
    'SELECT * FROM email_verification_tokens WHERE jti = $1',
    [jti],
  );
  return result.rows[0] ?? null;
}

/**
 * Fetch the most recently created pending or verified (non-expired) token for a user.
 * Returns null if none found.
 */
export async function getActiveTokenForUser(
  botId: string,
  userId: number,
  pool: Queryable = defaultPool,
): Promise<EmailVerificationTokenRow | null> {
  logger.debug({ botId, userId }, 'getActiveTokenForUser');
  const result = await pool.query<EmailVerificationTokenRow>(
    `SELECT * FROM email_verification_tokens
     WHERE bot_id = $1 AND user_id = $2
       AND status IN ('pending', 'verified')
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [botId, userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically mark a token as verified only if its current status is 'pending'.
 * Returns the updated row, or null if the row was not in 'pending' status (race condition).
 */
export async function markVerifiedAtomic(
  jti: string,
  pool: Pool = defaultPool,
): Promise<EmailVerificationTokenRow | null> {
  logger.debug({ jti }, 'markVerifiedAtomic');
  const result = await pool.query<EmailVerificationTokenRow>(
    `UPDATE email_verification_tokens
     SET status = 'verified', verified_at = now()
     WHERE jti = $1 AND status = 'pending'
     RETURNING *`,
    [jti],
  );
  return result.rows[0] ?? null;
}

/**
 * BLOCKER 2: Extend expires_at on an already-verified token (re-click path).
 * Only updates rows where status = 'verified' to avoid interfering with other states.
 */
export async function extendExpiry(
  jti: string,
  newExpiresAt: Date,
  pool: Queryable = defaultPool,
): Promise<void> {
  logger.debug({ jti }, 'extendExpiry');
  await pool.query(
    `UPDATE email_verification_tokens SET expires_at = $2 WHERE jti = $1 AND status = 'verified'`,
    [jti, newExpiresAt],
  );
}

/**
 * Mark a token as notified, recording notified_at timestamp.
 * Only transitions from 'verified' → 'notified' (guards against double-notify races).
 * Returns the number of rows updated (0 = already notified or race).
 */
export async function markNotified(
  jti: string,
  pool: Pool = defaultPool,
): Promise<number> {
  logger.debug({ jti }, 'markNotified');
  const result = await pool.query(
    `UPDATE email_verification_tokens
     SET status = 'notified', notified_at = now()
     WHERE jti = $1 AND status = 'verified'`,
    [jti],
  );
  return result.rowCount ?? 0;
}

/**
 * Delete all tokens for a given bot+user pair.
 */
export async function deleteTokensForUser(
  botId: string,
  userId: number,
  pool: Queryable = defaultPool,
): Promise<void> {
  logger.debug({ botId, userId }, 'deleteTokensForUser');
  await pool.query(
    'DELETE FROM email_verification_tokens WHERE bot_id = $1 AND user_id = $2',
    [botId, userId],
  );
}
