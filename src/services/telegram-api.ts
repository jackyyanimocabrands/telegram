import { logger } from '../utils/logger.js';
import { TelegramApiError } from '../utils/errors.js';
import dns from 'node:dns';
import type {
  TelegramApiResponse,
  TelegramUser,
  BotCommand,
  WebhookInfo,
  Update,
} from '../types/telegram.js';

const BASE_URL = 'https://api.telegram.org';

// Force IPv4 at module load — api.telegram.org does not respond on IPv6.
// Called once here so a misconfiguration is caught at startup, not on first request.
dns.setDefaultResultOrder('ipv4first');
logger.debug('DNS default result order set to ipv4first');

// Keep the guard so hot-reload / test environments that re-import don't double-log.
let ipv4Configured = false;
function ensureIPv4(): void {
  if (!ipv4Configured) {
    ipv4Configured = true;
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

  static async getUpdates(
    token: string,
    offset: number,
    timeout: number,
    allowedUpdates: string[],
    signal?: AbortSignal,
    limit = 100,
  ): Promise<Update[]> {
    logger.debug({ offset, timeout, limit, allowedUpdates }, 'getUpdates: called');
    const url = `${BASE_URL}/bot${token}/getUpdates`;
    ensureIPv4();
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

  static async deleteWebhook(token: string): Promise<boolean> {
    logger.debug('deleteWebhook: called');
    return this.call<boolean>(token, 'deleteWebhook', { drop_pending_updates: false });
  }
}
