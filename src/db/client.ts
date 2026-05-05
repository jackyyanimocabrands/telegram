import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// MI-11: Register BIGINT type parser — pg returns BIGINT (OID 20) as strings by default.
// polling_offset is BIGINT; without this, parseInt on a string would silently produce NaN.
pg.types.setTypeParser(20, (val: string) => parseInt(val, 10));

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
