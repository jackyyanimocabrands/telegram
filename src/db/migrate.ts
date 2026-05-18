import { Flyway } from 'node-flyway';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

function toJdbcConfig(databaseUrl: string): { url: string; user: string; password: string } {
  const parsed = new URL(databaseUrl);
  const jdbcUrl = `jdbc:postgresql://${parsed.host}${parsed.pathname}`;
  return {
    url: jdbcUrl,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

export async function runMigrations(): Promise<void> {
  const { url, user, password } = toJdbcConfig(env.DATABASE_URL);

  const flyway = new Flyway({
    url,
    user,
    password,
    migrationLocations: ['filesystem:./migrations'],
    advanced: {
      validateOnMigrate: true,
    },
  });

  logger.info('Running Flyway migrations...');
  const result = await flyway.migrate();

  if (!result.success) {
    logger.error({ result }, 'Flyway migration failed');
    throw new Error(`Flyway migration failed: ${result.error?.message ?? 'unknown error'}`);
  }

  logger.info(
    {
      migrationsExecuted: result.flywayResponse?.migrationsExecuted,
      schemaVersion: result.flywayResponse?.targetSchemaVersion,
    },
    'Flyway migrations complete',
  );
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
