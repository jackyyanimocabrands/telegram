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
  LOG_DIR: z.string().default('logs'),
  MANAGER_UPDATE_MODE: z.enum(['polling', 'webhook', 'auto'])
    .default('auto')
    .transform((val) => {
      if (val === 'auto') {
        return process.env.NODE_ENV === 'production' ? 'webhook' : 'polling';
      }
      return val;
    }),
  // LLM provider configuration
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  DEFAULT_LLM_PROVIDER: z.enum(['openai', 'anthropic', 'deepseek', 'openrouter']).default('openai'),
  DEFAULT_LLM_MODEL: z.string().default('gpt-4o'),
  DEFAULT_SUMMARIZATION_PROVIDER: z.enum(['openai', 'anthropic', 'deepseek', 'openrouter']).default('openai'),
  DEFAULT_SUMMARIZATION_MODEL: z.string().default('gpt-4o-mini'),
  FALLBACK_LLM_PROVIDER: z.enum(['openai', 'anthropic', 'deepseek', 'openrouter']).optional(),
  FALLBACK_LLM_MODEL: z.string().optional(),
  // Manager bot system prompts (optional — hardcoded defaults used if absent)
  MANAGER_ONBOARDING_PROMPT: z.string().optional(),
  MANAGER_SETTINGS_PROMPT: z.string().optional(),
  // Streaming — minimum ms between sendMessageDraft calls; 0 = no throttle (full throttle)
  STREAM_THROTTLE_MS: z.coerce.number().int().min(0).default(0),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  MANAGER_THROTTLE_MS: z.coerce.number().int().min(0).default(5000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  JOB_RETENTION_HOURS: z.coerce.number().int().min(0).default(24),
  LOCK_TTL_SECS: z.coerce.number().int().min(10).default(60),
}).superRefine((data, ctx) => {
  // DEFAULT_LLM_PROVIDER key requirements
  if (data.DEFAULT_LLM_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENAI_API_KEY'], message: 'OPENAI_API_KEY is required when DEFAULT_LLM_PROVIDER is "openai"' });
  }
  if (data.DEFAULT_LLM_PROVIDER === 'anthropic' && !data.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ANTHROPIC_API_KEY'], message: 'ANTHROPIC_API_KEY is required when DEFAULT_LLM_PROVIDER is "anthropic"' });
  }
  if (data.DEFAULT_LLM_PROVIDER === 'deepseek' && !data.DEEPSEEK_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DEEPSEEK_API_KEY'], message: 'DEEPSEEK_API_KEY is required when DEFAULT_LLM_PROVIDER is "deepseek"' });
  }
  if (data.DEFAULT_LLM_PROVIDER === 'openrouter' && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENROUTER_API_KEY'], message: 'OPENROUTER_API_KEY is required when DEFAULT_LLM_PROVIDER is "openrouter"' });
  }
  // DEFAULT_SUMMARIZATION_PROVIDER key requirements
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENAI_API_KEY'], message: 'OPENAI_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "openai"' });
  }
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'anthropic' && !data.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ANTHROPIC_API_KEY'], message: 'ANTHROPIC_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "anthropic"' });
  }
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'deepseek' && !data.DEEPSEEK_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DEEPSEEK_API_KEY'], message: 'DEEPSEEK_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "deepseek"' });
  }
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'openrouter' && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENROUTER_API_KEY'], message: 'OPENROUTER_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "openrouter"' });
  }
  // FALLBACK_LLM_PROVIDER and FALLBACK_LLM_MODEL must both be set or neither
  const hasProvider = data.FALLBACK_LLM_PROVIDER !== undefined;
  const hasModel = data.FALLBACK_LLM_MODEL !== undefined;
  if (hasProvider && !hasModel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FALLBACK_LLM_MODEL'], message: 'FALLBACK_LLM_MODEL is required when FALLBACK_LLM_PROVIDER is set' });
  }
  if (hasModel && !hasProvider) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FALLBACK_LLM_PROVIDER'], message: 'FALLBACK_LLM_PROVIDER is required when FALLBACK_LLM_MODEL is set' });
  }
  // FALLBACK_LLM_PROVIDER API key requirements
  if (data.FALLBACK_LLM_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'OPENAI_API_KEY is required when FALLBACK_LLM_PROVIDER is openai', path: ['OPENAI_API_KEY'] });
  }
  if (data.FALLBACK_LLM_PROVIDER === 'anthropic' && !data.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ANTHROPIC_API_KEY is required when FALLBACK_LLM_PROVIDER is anthropic', path: ['ANTHROPIC_API_KEY'] });
  }
  if (data.FALLBACK_LLM_PROVIDER === 'deepseek' && !data.DEEPSEEK_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'DEEPSEEK_API_KEY is required when FALLBACK_LLM_PROVIDER is deepseek', path: ['DEEPSEEK_API_KEY'] });
  }
  if (data.FALLBACK_LLM_PROVIDER === 'openrouter' && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'OPENROUTER_API_KEY is required when FALLBACK_LLM_PROVIDER is openrouter', path: ['OPENROUTER_API_KEY'] });
  }
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
