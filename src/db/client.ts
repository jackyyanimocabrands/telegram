import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err: Error) => {
  logger.error({ err }, 'Unexpected PG pool error');
});

pool.on('connect', () => {
  logger.debug('New PG client connected to pool');
});

export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('PG pool closed');
}
