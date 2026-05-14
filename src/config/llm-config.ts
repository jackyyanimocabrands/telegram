import { z } from 'zod';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { env } from './env.js';

// Anchor the project root to the package directory, not process.cwd().
// __dirname here = src/config/  →  project root = ../../  (two levels up)
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../');

export const LlmSlotSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'deepseek', 'openrouter']),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.7),
});
export type LlmSlotConfig = z.infer<typeof LlmSlotSchema>;

export const LlmConfigSchema = z.object({
  chat: z.array(LlmSlotSchema).min(1, 'At least one chat LLM slot is required'),
  summarization: z.array(LlmSlotSchema).min(1, 'At least one summarization LLM slot is required'),
});
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/** Exported for unit testing — validates that all providers referenced in config have API keys in env */
export function validateApiKeys(config: LlmConfig, apiKeys: Record<string, string | undefined>): void {
  const slots = [...config.chat, ...config.summarization];
  const seen = new Set<string>();
  for (const slot of slots) {
    if (seen.has(slot.provider)) continue;
    seen.add(slot.provider);
    if (!apiKeys[slot.provider]) {
      throw new Error(`API key missing for provider "${slot.provider}" referenced in LLM config. Set the corresponding *_API_KEY environment variable.`);
    }
  }
}

/** Exported for unit testing — loads and validates the config file at the given path.
 *
 * LLM_CONFIG_PATH (if set) is resolved against the project root, not an arbitrary
 * filesystem location. This is an operator-controlled deployment env var; absolute
 * paths outside the project root are intentionally not supported.
 */
export function loadLlmConfig(configPath?: string): LlmConfig {
  // Prefer explicit configPath arg (used in tests), then env var (resolved against
  // project root), then the default path relative to project root.
  const rawPath = configPath ?? (env.LLM_CONFIG_PATH ? resolve(PROJECT_ROOT, env.LLM_CONFIG_PATH) : null) ?? resolve(PROJECT_ROOT, 'config/llm.json');
  const resolvedPath = resolve(rawPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to load LLM config: ${msg}`);
    process.exit(1);
  }

  const parsed = LlmConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('Invalid LLM config:');
    console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
    process.exit(1);
  }

  const apiKeys: Record<string, string | undefined> = {
    openai:     env.OPENAI_API_KEY,
    anthropic:  env.ANTHROPIC_API_KEY,
    deepseek:   env.DEEPSEEK_API_KEY,
    openrouter: env.OPENROUTER_API_KEY,
  };

  try {
    validateApiKeys(parsed.data, apiKeys);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  }

  return parsed.data;
}

export const llmConfig: LlmConfig = loadLlmConfig();
