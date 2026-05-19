import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { updateToolsetState } from '../../db/queries/conversations.js';
import { pool as defaultPool } from '../../db/client.js';
import type { Pool } from 'pg';
import { logger } from '../../utils/logger.js';

export const SAVE_MIND_CONTEXT_SUCCESS_MSG = 'Use case saved. You can now proceed to ask the user for their email.';
export const SAVE_MIND_CONTEXT_ERROR_MSG = 'ERROR: Failed to save use case. Please try again.';

export const MIND_USE_CASE_VALUES = ['General Assistant', 'Research', 'Customer Support', 'Coding', 'Writing'] as const;
export type MindUseCase = typeof MIND_USE_CASE_VALUES[number];

export function createSaveMindContextTool(botId: string, userId: string, pool: Pool = defaultPool) {
  const userIdNum = Number(userId);
  if (!Number.isFinite(userIdNum) || userIdNum <= 0) {
    throw new Error(`createSaveMindContextTool: invalid userId "${userId}" — must be a positive integer`);
  }
  return tool(
    async ({ use_case }) => {
      logger.debug({ botId, userId }, 'save_mind_context tool: invoked');
      try {
        await updateToolsetState(botId, userIdNum, { pending_use_case: use_case }, pool);
        return SAVE_MIND_CONTEXT_SUCCESS_MSG;
      } catch (err) {
        logger.error({ err, botId, userId }, 'save_mind_context tool: updateToolsetState failed');
        return SAVE_MIND_CONTEXT_ERROR_MSG;
      }
    },
    {
      name: 'save_mind_context',
      description: 'Save the user\'s confirmed Mind use case. Call this once the user has chosen their use case. Allowed values: General Assistant, Research, Customer Support, Coding, Writing.',
      schema: z.object({
        use_case: z.enum(['General Assistant', 'Research', 'Customer Support', 'Coding', 'Writing'])
          .describe('The confirmed use case for the Mind. Must be one of the predefined options.'),
      }),
    },
  );
}
