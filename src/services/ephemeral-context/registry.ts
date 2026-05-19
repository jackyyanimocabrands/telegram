import { SystemMessage } from '@langchain/core/messages';
import { logger } from '../../utils/logger.js';
import type { Env } from '../../config/env.js';
import type { EphemeralContextPlugin, EphemeralContextInput } from './types.js';

/**
 * Runs all enabled plugins in parallel via Promise.allSettled.
 * Assembles non-null non-empty results into a [Context] SystemMessage.
 * Returns null if global kill-switch off, no enabled plugins, or all omit.
 * Never throws — plugin failures are logged and omitted.
 */
export async function buildEphemeralContext(
  plugins: EphemeralContextPlugin[],
  input: EphemeralContextInput,
  env: Env,
): Promise<SystemMessage | null> {
  if (!env.EPHEMERAL_CONTEXT_ENABLED) return null;

  const enabledPlugins = plugins.filter(p => {
    try {
      return p.enabled(env);
    } catch (err) {
      logger.warn({ pluginName: p.name, err }, 'ephemeral-context: plugin enabled() threw, skipping');
      return false;
    }
  });
  if (enabledPlugins.length === 0) return null;

  const results = await Promise.allSettled(
    enabledPlugins.map(p => p.build(input)),
  );

  const lines: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const plugin = enabledPlugins[i]!;
    if (result.status === 'rejected') {
      logger.warn({ pluginName: plugin.name, err: result.reason }, 'ephemeral-context: plugin rejected');
      continue;
    }
    const value = result.value;
    if (value != null && String(value).trim() !== '') {
      lines.push(String(value).trim());
    }
  }

  if (lines.length === 0) return null;

  return new SystemMessage(`[Context]\n${lines.join('\n')}`);
}
