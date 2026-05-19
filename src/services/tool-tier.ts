import type { StructuredTool } from '@langchain/core/tools';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import {
  createWebsearchTool,
  createWebfetchTool,
  createVerifyEmailTool,
  createClearEmailVerificationTool,
  createCheckBotUsernameTool,
  createSaveMindContextTool,
} from './tools/index.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ToolTier = 'base' | 'authenticated';

/**
 * Matches the JSONB shape stored in conversations.toolset_state.
 * Additional fields are allowed (index signature).
 */
export interface ToolsetState {
  email?: string;
  email_verified?: boolean;
  [key: string]: unknown;
}

/**
 * Dependencies injected into tool factories.
 * redisClient is optional — tools that need Redis will fail gracefully if absent.
 */
export interface ToolDeps {
  userEmail: string;
  botId: string;
  userId: string;
  redisClient?: Redis;
  pool?: Pool;
}

// ── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Returns 'authenticated' if toolsetState.email_verified is strictly true,
 * otherwise 'base'.
 */
export function resolveToolTier(toolsetState: ToolsetState): ToolTier {
  return toolsetState.email_verified === true ? 'authenticated' : 'base';
}

// ── Tool list builder ────────────────────────────────────────────────────────

/**
 * Returns the tools available for the given tier.
 *
 * base          → [verify_email, check_bot_username, web_fetch, web_search]
 * authenticated → [clear_email_verification, create_bot, configure_bot, check_bot_username, web_fetch, web_search]
 */
export function getToolsForTier(tier: ToolTier, deps: ToolDeps): StructuredTool[] {
  const sharedTools = [
    createWebfetchTool({ botId: deps.botId, userId: deps.userId, redisClient: deps.redisClient }),
    createWebsearchTool(undefined, deps.botId, deps.userId),
  ];

  if (tier === 'base') {
    return [
      createVerifyEmailTool(deps.botId, deps.userId),
      createSaveMindContextTool(deps.botId, deps.userId, deps.pool),
      createCheckBotUsernameTool(deps.botId, deps.userId),
      ...sharedTools,
    ];
  }

  // authenticated
  return [
    createClearEmailVerificationTool(deps.botId, deps.userId, deps.pool),
    createCheckBotUsernameTool(deps.botId, deps.userId),
    ...sharedTools,
  ];
}
