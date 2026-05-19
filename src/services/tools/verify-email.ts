import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { sendVerificationEmail } from '../email-verification.js';
import { logger } from '../../utils/logger.js';

export function createVerifyEmailTool(botId: string, userId: string) {
  return tool(
    async ({ email }) => {
      logger.debug({ botId, userId }, 'verify_email tool: invoked');
      try {
        await sendVerificationEmail(email, botId, userId);
        return `Verification email sent to ${email}. Ask the user to check their inbox and click the verification link.`;
      } catch (err) {
        logger.error({ err, botId, userId }, 'verify_email tool: sendVerificationEmail failed');
        return 'ERROR: Failed to send verification email. Please try again later. Do not tell the user the email was sent.';
      }
    },
    {
      name: 'verify_email',
      description: 'Send or resend a verification email to confirm the user owns an email address. Call this when: (1) the user provides their email for the first time, (2) the user asks to resend or says they did not receive the email, (3) the user wants to try again. Always call this tool — never confirm an email was sent without an active call in this response.',
      schema: z.object({
        email: z.string().email().describe('The email address to verify'),
      }),
    },
  );
}
