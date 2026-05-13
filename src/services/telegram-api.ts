import { logger } from '../utils/logger.js';
import { TelegramApiError } from '../utils/errors.js';
import dns from 'node:dns';
import type {
  TelegramApiResponse,
  TelegramUser,
  BotCommand,
  WebhookInfo,
  Update,
  Message,
} from '../types/telegram.js';

/**
 * Parameters for long-polling getUpdates.
 * TelegramApiClient.getUpdates uses positional args; this interface captures
 * the same fields for use by TelegramClient implementations.
 */
export interface GetUpdatesParams {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowedUpdates?: string[];
  signal?: AbortSignal;
}

/**
 * Abstraction over the Telegram Bot API HTTP surface.
 * Allows BotRegistry and ManagedBotService to be driven by a mock in tests,
 * eliminating esmock on TelegramApiClient static methods.
 */
export interface TelegramClient {
  getMe(token: string): Promise<TelegramUser>;
  getUpdates(
    token: string,
    offset: number,
    timeout: number,
    allowedUpdates: string[],
    signal?: AbortSignal,
    limit?: number,
  ): Promise<Update[]>;
  setWebhook(
    token: string,
    url: string,
    allowedUpdates: string[],
    secretToken: string,
  ): Promise<boolean>;
  deleteWebhook(token: string): Promise<boolean>;
  getWebhookInfo(token: string): Promise<WebhookInfo>;
  sendMessage(
    token: string,
    chatId: number | string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<Message>;
  sendMessageDraft(
    token: string,
    chatId: number | string,
    draftId: number,
    text?: string,
  ): Promise<boolean>;
  setMyName(token: string, name: string, description?: string): Promise<boolean>;
  setMyDescription(token: string, description: string): Promise<boolean>;
  setMyShortDescription(token: string, description: string): Promise<boolean>;
  setMyCommands(token: string, commands: BotCommand[]): Promise<boolean>;
  answerCallbackQuery(
    token: string,
    callbackQueryId: string,
    text?: string,
  ): Promise<boolean>;
  replaceManagedBotToken(managerToken: string, botUserId: number): Promise<string>;
}

const BASE_URL = 'https://api.telegram.org';

// Force IPv4 at module load — api.telegram.org does not respond on IPv6.
// Called once here so a misconfiguration is caught at startup, not on first request.
dns.setDefaultResultOrder('ipv4first');
logger.debug('DNS default result order set to ipv4first');

export class HttpTelegramClient implements TelegramClient {
  private static _instance: HttpTelegramClient | null = null;

  static getInstance(): HttpTelegramClient {
    if (!HttpTelegramClient._instance) {
      HttpTelegramClient._instance = new HttpTelegramClient();
    }
    return HttpTelegramClient._instance;
  }

  private async call<T>(
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

  async getMe(token: string): Promise<TelegramUser> {
    logger.debug('getMe: called');
    return this.call<TelegramUser>(token, 'getMe');
  }

  async getUpdates(
    token: string,
    offset: number,
    timeout: number,
    allowedUpdates: string[],
    signal?: AbortSignal,
    limit = 100,
  ): Promise<Update[]> {
    logger.debug({ offset, timeout, limit, allowedUpdates }, 'getUpdates: called');
    const url = `${BASE_URL}/bot${token}/getUpdates`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // M-05: Explicitly pass both `limit` (max updates to return) and `timeout`
        // (long-poll seconds) as separate fields — they are distinct Telegram API params.
        body: JSON.stringify({ offset, limit, timeout, allowed_updates: allowedUpdates }),
        signal,
      });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err;
      logger.error({ err }, 'getUpdates: network error');
      throw err;
    }
    const data = (await res.json()) as TelegramApiResponse<Update[]>;
    if (!data.ok || data.result === undefined) {
      logger.warn({ errorCode: data.error_code, description: data.description }, 'getUpdates: ok=false');
      throw new TelegramApiError('getUpdates', data.error_code ?? res.status, data.description ?? 'Unknown error');
    }
    return data.result;
  }

  async setWebhook(
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

  async deleteWebhook(token: string): Promise<boolean> {
    logger.debug('deleteWebhook: called');
    return this.call<boolean>(token, 'deleteWebhook', { drop_pending_updates: false });
  }

  async getWebhookInfo(token: string): Promise<WebhookInfo> {
    logger.debug('getWebhookInfo: called');
    return this.call<WebhookInfo>(token, 'getWebhookInfo');
  }

  async sendMessage(
    token: string,
    chatId: number | string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<Message> {
    logger.debug({ chatId, textLength: text.length }, 'sendMessage: called');
    return this.call<Message>(token, 'sendMessage', { chat_id: chatId, text, ...options });
  }

  async sendMessageDraft(
    token: string,
    chatId: number | string,
    draftId: number,
    text?: string,
  ): Promise<boolean> {
    logger.debug({ chatId, draftId, textLength: (text ?? '').length }, 'sendMessageDraft: called');
    return this.call<boolean>(token, 'sendMessageDraft', {
      chat_id: chatId,
      draft_id: draftId,
      text: text ?? '',
    });
  }

  async setMyName(token: string, name: string, _description?: string): Promise<boolean> {
    logger.debug({ name }, 'setMyName: called');
    return this.call<boolean>(token, 'setMyName', { name });
  }

  async setMyDescription(token: string, description: string): Promise<boolean> {
    logger.debug({ descriptionLength: description.length }, 'setMyDescription: called');
    return this.call<boolean>(token, 'setMyDescription', { description });
  }

  async setMyShortDescription(token: string, description: string): Promise<boolean> {
    logger.debug({ descriptionLength: description.length }, 'setMyShortDescription: called');
    return this.call<boolean>(token, 'setMyShortDescription', { description });
  }

  async setMyCommands(token: string, commands: BotCommand[]): Promise<boolean> {
    logger.debug({ commandCount: commands.length }, 'setMyCommands: called');
    return this.call<boolean>(token, 'setMyCommands', { commands });
  }

  async answerCallbackQuery(
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

  async replaceManagedBotToken(managerToken: string, botUserId: number): Promise<string> {
    logger.debug({ botUserId }, 'replaceManagedBotToken: called');
    return this.call<string>(managerToken, 'replaceManagedBotToken', { user_id: botUserId });
  }
}
