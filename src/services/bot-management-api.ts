import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface CreateBotParams {
  name: string;
  username?: string;
  botToken?: string;
  description?: string;
  systemPrompt?: string;
}

export interface ConfigureBotParams {
  name?: string;
  description?: string;
  systemPrompt?: string;
}

export interface CreateBotResult {
  id: string;
  name: string;
}

export interface ConfigureBotResult {
  id: string;
  name: string;
}

export class BotManagementApiClient {
  private buildHeaders(userEmail: string): Record<string, string> {
    const safeEmail = userEmail.replace(/[\r\n\0]/g, '');
    if (safeEmail.length === 0) {
      throw new Error('userEmail is empty or contains only invalid characters');
    }
    return {
      Authorization: `Bearer ${env.BOT_MGMT_API_KEY ?? ''}`,
      'X-User-Email': safeEmail,
      'Content-Type': 'application/json',
    };
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = await response.json() as Record<string, unknown>;
        if (typeof body.error === 'string') {
          message = body.error;
        }
      } catch {
        // ignore JSON parse failure — use statusText
      }
      throw new Error(message);
    }
    return response.json() as Promise<T>;
  }

  async createBot(userEmail: string, params: CreateBotParams): Promise<CreateBotResult> {
    if (!env.BOT_MGMT_API_URL || !env.BOT_MGMT_API_KEY) {
      throw new Error('Bot management API is not configured. Set BOT_MGMT_API_URL and BOT_MGMT_API_KEY.');
    }
    try {
      const response = await fetch(`${env.BOT_MGMT_API_URL}/bots`, {
        method: 'POST',
        headers: this.buildHeaders(userEmail),
        body: JSON.stringify(params),
      });
      return this.handleResponse<CreateBotResult>(response);
    } catch (err) {
      logger.error({ err, userEmail }, 'BotManagementApiClient.createBot failed');
      throw err;
    }
  }

  async configureBot(
    userEmail: string,
    botId: string,
    params: ConfigureBotParams,
  ): Promise<ConfigureBotResult> {
    if (!env.BOT_MGMT_API_URL || !env.BOT_MGMT_API_KEY) {
      throw new Error('Bot management API is not configured. Set BOT_MGMT_API_URL and BOT_MGMT_API_KEY.');
    }
    try {
      const response = await fetch(`${env.BOT_MGMT_API_URL}/bots/${botId}`, {
        method: 'PATCH',
        headers: this.buildHeaders(userEmail),
        body: JSON.stringify(params),
      });
      return this.handleResponse<ConfigureBotResult>(response);
    } catch (err) {
      logger.error({ err, userEmail, botId }, 'BotManagementApiClient.configureBot failed');
      throw err;
    }
  }
}

export const botManagementApi = new BotManagementApiClient();
