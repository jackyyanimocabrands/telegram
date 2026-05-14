import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { deleteTokensForUser } from '../../db/queries/email-verification-tokens.js';
import { updateToolsetState } from '../../db/queries/conversations.js';
import { pool as defaultPool } from '../../db/client.js';
import type { Pool } from 'pg';
import { logger } from '../../utils/logger.js';

// BLOCKER 13: wrap the two sequential writes in a pg transaction to ensure atomicity
export function createClearEmailVerificationTool(botId: string, userId: string, pool: Pool = defaultPool) {
  const userIdNum = Number(userId);
  return tool(
    async () => {
      logger.debug({ botId, userId }, 'clear_email_verification tool: invoked');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await deleteTokensForUser(botId, userIdNum, client);
        await updateToolsetState(botId, userIdNum, { email: null, email_verified: false }, client);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return 'Email verification cleared. You can now verify a different email address.';
    },
    {
      name: 'clear_email_verification',
      description: 'Clear the current email verification, unlinking the verified email and restoring access to the verify_email tool.',
      schema: z.object({}),
    },
  );
}
