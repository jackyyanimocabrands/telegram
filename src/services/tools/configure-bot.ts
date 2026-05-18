import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  botManagementApi,
  BotManagementApiClient,
} from '../bot-management-api.js';
import { logger } from '../../utils/logger.js';

export function createConfigureBotTool(
  userEmail: string,
  client: BotManagementApiClient = botManagementApi,
  botId?: string,
  userId?: string,
) {
  return tool(
    async (input) => {
      logger.debug({ botId, userId }, 'configure_bot tool: invoked');
      try {
        const result = await client.configureBot(userEmail, input.botId, {
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
      name: 'configure_bot',
      description:
        'Configure an existing Telegram bot. Requires email-verified user.',
      schema: z.object({
        botId: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        systemPrompt: z.string().optional(),
      }),
    },
  );
}
