import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { sendVerificationEmail } from '../email-verification.js';
import { logger } from '../../utils/logger.js';

export function createVerifyEmailTool(botId: string, userId: string) {
  return tool(
    async ({ email }) => {
      logger.debug({ botId, userId }, 'verify_email tool: invoked');
      await sendVerificationEmail(email, botId, userId);
      return `Verification email sent to ${email}. Please click the link in the email to verify your identity.`;
    },
    {
      name: 'verify_email',
      description: 'Send a verification email to confirm the user owns an email address. Call this when the user wants to verify their email to unlock additional tools.',
      schema: z.object({
        email: z.string().email().describe('The email address to verify'),
      }),
    },
  );
}
