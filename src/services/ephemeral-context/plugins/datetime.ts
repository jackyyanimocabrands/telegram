import type { EphemeralContextPlugin } from '../types.js';
import type { Env } from '../../../config/env.js';

function formatDate(date: Date, format: Env['DATETIME_FORMAT']): string {
  switch (format) {
    case 'rfc2822': return date.toUTCString();
    case 'unix': return String(Math.floor(date.getTime() / 1000));
    case 'iso':
    default: return date.toISOString();
  }
}

/**
 * Factory: captures env.DATETIME_FORMAT in closure so build() stays pure
 * and receives only EphemeralContextInput.
 */
export function createDatetimePlugin(env: Env): EphemeralContextPlugin {
  return {
    name: 'datetime',
    enabled: (e) => e.EPHEMERAL_CONTEXT_DATETIME_ENABLED,
    build: ({ getNow }) => {
      return `Current UTC date and time: ${formatDate(getNow(), env.DATETIME_FORMAT)}`;
    },
  };
}
