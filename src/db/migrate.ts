import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export async function runMigrations(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const { rows: applied } = await client.query('SELECT filename FROM _migrations ORDER BY id');
    const appliedSet = new Set(applied.map((r: { filename: string }) => r.filename));

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f: string) => f.endsWith('.sql'))
      .sort();

    let count = 0;

    for (const file of files) {
      if (appliedSet.has(file)) {
        logger.debug({ file }, 'Migration already applied, skipping');
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      logger.info({ file }, 'Applying migration');

      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      count++;
    }

    await client.query('COMMIT');
    logger.info({ count }, 'Migrations complete');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Migration failed, rolled back');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
