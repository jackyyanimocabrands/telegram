import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';

/** Validates Telegram bot username format rules */
function isValidBotUsername(username: string): { valid: boolean; reason?: string } {
  if (username.length < 5 || username.length > 32) {
    return { valid: false, reason: 'Username must be between 5 and 32 characters.' };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { valid: false, reason: 'Username may only contain letters, numbers, and underscores.' };
  }
  if (!username.toLowerCase().endsWith('_bot')) {
    return { valid: false, reason: 'Username must end with _bot.' };
  }
  return { valid: true };
}

export function createCheckBotUsernameTool(botId?: string, userId?: string) {
  return tool(
    async (input) => {
      logger.debug({ botId, userId, username: input.username }, 'check_bot_username tool: invoked');

      const formatCheck = isValidBotUsername(input.username);
      if (!formatCheck.valid) {
        return JSON.stringify({ available: false, username: input.username, reason: formatCheck.reason });
      }

      // TODO: Replace with real API call to BOT_MGMT_API_URL/bots/check?username={username}
      // Mock: all validly-formatted usernames are considered available
      return JSON.stringify({ available: true, username: input.username });
    },
    {
      name: 'check_bot_username',
      description:
        'Check if a bot username is available on HelloMinds. The username must end in _bot, be 5–32 characters, and contain only letters, numbers, and underscores. Returns { available, username, reason? }.',
      schema: z.object({
        username: z.string().describe('The proposed Telegram bot username to check (must end in _bot).'),
      }),
    },
  );
}
