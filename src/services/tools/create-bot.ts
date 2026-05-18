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
          description: input.description,
          systemPrompt: input.systemPrompt,
        });
        return JSON.stringify(result);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    {
      name: 'create_bot',
      description:
        'Create a new Telegram bot via the bot management service. Requires email-verified user.',
      schema: z.object({
        name: z.string(),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
      }),
    },
  );
}
