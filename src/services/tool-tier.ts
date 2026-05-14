import type { StructuredTool } from '@langchain/core/tools';
import type { Redis } from 'ioredis';
import {
  createCreateBotTool,
  createConfigureBotTool,
  createWebsearchTool,
  createWebfetchTool,
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
 * base          → [webfetch, websearch]
 * authenticated → [createBot, configureBot, webfetch, websearch]
 */
export function getToolsForTier(tier: ToolTier, deps: ToolDeps): StructuredTool[] {
  const sharedTools = [
    createWebfetchTool({ botId: deps.botId, userId: deps.userId, redisClient: deps.redisClient }),
    createWebsearchTool(),
  ];

  if (tier === 'base') {
    return sharedTools;
  }

  // authenticated
  return [
    createCreateBotTool(deps.userEmail),
    createConfigureBotTool(deps.userEmail),
    ...sharedTools,
  ];
}
