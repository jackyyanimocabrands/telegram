import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  botManagementApi,
  BotManagementApiClient,
} from '../bot-management-api.js';

export function createConfigureBotTool(
  userEmail: string,
  client: BotManagementApiClient = botManagementApi,
) {
  return tool(
    async (input) => {
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
