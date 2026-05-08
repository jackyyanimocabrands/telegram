import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

if (process.env.NODE_ENV !== 'production') {
  dotenvConfig();
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  BOT_USERNAME: z.string().min(1, 'BOT_USERNAME is required').transform(v => v.replace(/^@/, '')),
  WEBHOOK_SECRET: z.string().min(32).regex(/^[A-Za-z0-9_\-]+$/, 'WEBHOOK_SECRET must be at least 32 chars and contain only [A-Za-z0-9_-]'),
  CHILD_WEBHOOK_SECRET: z.string().min(32).regex(/^[A-Za-z0-9_\-]+$/, 'CHILD_WEBHOOK_SECRET must be at least 32 chars and contain only [A-Za-z0-9_-]'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  ENCRYPTION_MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'ENCRYPTION_MASTER_KEY must be 64 hex chars (32 bytes)'),
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  ES256_PRIVATE_KEY: z.string().min(1, 'ES256_PRIVATE_KEY is required'),
  ES256_PUBLIC_KEY: z.string().min(1, 'ES256_PUBLIC_KEY is required'),
  JWT_EXPIRES_IN: z.coerce.number().int().positive().default(2592000), // 30 days in seconds
  JWT_REFRESH_EXPIRES_IN: z.coerce.number().int().positive().default(604800), // 7 days in seconds
  JWT_VERSION: z.coerce.number().int().positive().default(1),
  CORS_ORIGINS: z.string().optional(), // comma-separated, empty/absent = allow all in dev, deny in prod
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BASE_URL: z.string().url('BASE_URL must be a valid URL'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MANAGER_UPDATE_MODE: z.enum(['polling', 'webhook', 'auto'])
    .default('auto')
    .transform((val) => {
      if (val === 'auto') {
        return process.env.NODE_ENV === 'production' ? 'webhook' : 'polling';
      }
      return val;
    }),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;

/** Parsed CORS origins — null = allow all, empty array = none */
export function getCorsOrigins(): string[] | null {
  if (!env.CORS_ORIGINS) {
    return env.NODE_ENV === 'development' ? null : [];
  }
  return env.CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
}
