import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  botManagementApi,
  BotManagementApiClient,
} from '../bot-management-api.js';
import { logger } from '../../utils/logger.js';

export function createCreateBotTool(
  userEmail: string,
  client: BotManagementApiClient = botManagementApi,
  botId?: string,
  userId?: string,
) {
  return tool(
    async (input) => {
      logger.debug({ botId, userId }, 'create_bot tool: invoked');
      try {
        const result = await client.createBot(userEmail, {
          name: input.name,
          username: input.username,
          botToken: input.botToken,
          description: input.description,
          systemPrompt: input.systemPrompt,
        });
        return JSON.stringify(result);
      } catch (err) {
        logger.error({ err, botId, userId }, 'create_bot tool: createBot failed');
        return 'ERROR: Failed to create Mind. Please try again later.';
      }
    },
    {
      name: 'create_bot',
      description:
        'Create a new Telegram bot via the bot management service. Requires email-verified user.',
      schema: z.object({
        name: z.string().describe('Display name of the Mind.'),
        username: z.string().optional().describe('Telegram bot username (must end in _bot).'),
        botToken: z.string().optional().describe('Telegram bot token obtained from BotFather.'),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
      }),
    },
  );
}
