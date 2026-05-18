import type { Env } from '../../config/env.js';

/**
 * Fields from toolsetState that plugins are permitted to access.
 * This narrow type is a compile-time PII guard — TypeScript will reject any
 * plugin that attempts to read fields not listed here (e.g. email, email_verified).
 * Add new safe, non-PII fields here as needed.
 */
export interface PluginContextFields {
  timezone?: string;
  locale?: string;
}

export interface EphemeralContextInput {
  botId: string;
  userId: string;
  /** Only safe, non-PII fields from toolsetState. Never includes email, email_verified, etc. */
  toolsetState: PluginContextFields;
  getNow: () => Date;
}

export interface EphemeralContextPlugin {
  /** Unique name for logging */
  name: string;
  /**
   * Whether this specific plugin should run — evaluated per-request.
   * The global `EPHEMERAL_CONTEXT_ENABLED` kill-switch is enforced by the registry
   * and must NOT be checked here. Only check this plugin's own feature flag.
   */
  enabled: (env: Env) => boolean;
  /** Produce a context string, or null/empty to omit */
  build: (ctx: EphemeralContextInput) => Promise<string | null> | string | null;
}
