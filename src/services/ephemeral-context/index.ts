export { buildEphemeralContext } from './registry.js';
export { createDatetimePlugin } from './plugins/datetime.js';
export { localePlugin } from './plugins/locale.js';
export type { EphemeralContextPlugin, EphemeralContextInput, PluginContextFields } from './types.js';

import type { Env } from '../../config/env.js';
import type { EphemeralContextPlugin } from './types.js';
import { createDatetimePlugin } from './plugins/datetime.js';
import { localePlugin } from './plugins/locale.js';

/**
 * Factory for the default ordered plugin list.
 * Order: datetime first, locale second.
 */
export function createDefaultPlugins(env: Env): EphemeralContextPlugin[] {
  return [
    createDatetimePlugin(env),
    localePlugin,
  ];
}
