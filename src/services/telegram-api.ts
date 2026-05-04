import { logger } from '../utils/logger.js';
import { TelegramApiError } from '../utils/errors.js';
import dns from 'node:dns';
import type {
  TelegramApiResponse,
  TelegramUser,
  BotCommand,
  WebhookInfo,
} from '../types/telegram.js';

const BASE_URL = 'https://api.telegram.org';

// Force IPv4 once on first use — api.telegram.org does not respond on IPv6
let ipv4Configured = false;
function ensureIPv4(): void {
  if (!ipv4Configured) {
    dns.setDefaultResultOrder('ipv4first');
    ipv4Configured = true;
    logger.debug('DNS default result order set to ipv4first');
  }
}

export class TelegramApiClient {
  private static async call<T>(
    token: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${BASE_URL}/bot${token}/${method}`;

    const options: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    logger.debug({ method, hasBody: !!body }, 'Telegram API call: start');

    ensureIPv4();

    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (err) {
      logger.error({ err, method }, 'Telegram API call: network error (fetch failed)');
      throw err;
    }

    const data = (await res.json()) as TelegramApiResponse<T>;

    if (!data.ok || data.result === undefined) {
      logger.warn({ method, errorCode: data.error_code, description: data.description, statusCode: res.status }, 'Telegram API returned ok=false');
      throw new TelegramApiError(
        method,
        data.error_code ?? res.status,
        data.description ?? 'Unknown error',
      );
    }

    logger.debug({ method, statusCode: res.status }, 'Telegram API call: success');
    return data.result;
  }

  static async getMe(token: string): Promise<TelegramUser> {
    logger.debug('getMe: called');
    return this.call<TelegramUser>(token, 'getMe');
  }

  static async getManagedBotToken(managerToken: string, botUserId: number): Promise<string> {
    logger.debug({ botUserId }, 'getManagedBotToken: called');
    return this.call<string>(managerToken, 'getManagedBotToken', { user_id: botUserId });
  }

  static async replaceManagedBotToken(managerToken: string, botUserId: number): Promise<string> {
    logger.debug({ botUserId }, 'replaceManagedBotToken: called');
    return this.call<string>(managerToken, 'replaceManagedBotToken', { user_id: botUserId });
  }

  static async setWebhook(
    token: string,
    url: string,
    allowedUpdates: string[],
    secretToken: string,
  ): Promise<boolean> {
    logger.debug({ url, allowedUpdates }, 'setWebhook: called');
    return this.call<boolean>(token, 'setWebhook', {
      url,
      allowed_updates: allowedUpdates,
      secret_token: secretToken,
    });
  }

  static async getWebhookInfo(token: string): Promise<WebhookInfo> {
    logger.debug('getWebhookInfo: called');
    return this.call<WebhookInfo>(token, 'getWebhookInfo');
  }

  static async sendMessage(
    token: string,
    chatId: number | string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    logger.debug({ chatId, textLength: text.length }, 'sendMessage: called');
    return this.call(token, 'sendMessage', { chat_id: chatId, text, ...options });
  }

  static async setMyName(token: string, name: string): Promise<boolean> {
    logger.debug({ name }, 'setMyName: called');
    return this.call<boolean>(token, 'setMyName', { name });
  }

  static async setMyDescription(token: string, description: string): Promise<boolean> {
    logger.debug({ descriptionLength: description.length }, 'setMyDescription: called');
    return this.call<boolean>(token, 'setMyDescription', { description });
  }

  static async setMyShortDescription(token: string, description: string): Promise<boolean> {
    logger.debug({ descriptionLength: description.length }, 'setMyShortDescription: called');
    return this.call<boolean>(token, 'setMyShortDescription', { description });
  }

  static async setMyCommands(token: string, commands: BotCommand[]): Promise<boolean> {
    logger.debug({ commandCount: commands.length }, 'setMyCommands: called');
    return this.call<boolean>(token, 'setMyCommands', { commands });
  }

  static async answerCallbackQuery(
    token: string,
    callbackQueryId: string,
    text?: string,
  ): Promise<boolean> {
    logger.debug({ callbackQueryId, hasText: !!text }, 'answerCallbackQuery: called');
    return this.call<boolean>(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    });
  }
}
