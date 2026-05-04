import { TelegramApiClient } from './telegram-api.js';
import { logger } from '../utils/logger.js';
import * as appStateQueries from '../db/queries/app-state.js';
import * as managedBotQueries from '../db/queries/managed-bots.js';
import type { Update } from '../types/telegram.js';

export interface BotConfig {
  botId: number | 'manager';
  token: string;
  updateMode: 'polling' | 'webhook';
  allowedUpdates: string[];
  handler: (update: Update) => Promise<void>;
  // webhook-mode only:
  webhookUrl?: string;
  webhookSecret?: string;
  // polling-mode only:
  initialOffset?: number;
}

interface BotEntry extends BotConfig {
  abortController?: AbortController;
  pollingActive: boolean;
}

export class BotRegistry {
  private readonly bots: Map<number | 'manager', BotEntry> = new Map();
  private started = false;

  /** Register a bot. If registry is already started, immediately wires up its transport. */
  registerBot(config: BotConfig): void {
    const entry: BotEntry = { ...config, pollingActive: false };
    this.bots.set(config.botId, entry);
    logger.info({ botId: config.botId, updateMode: config.updateMode }, 'BotRegistry: registered bot');

    if (this.started) {
      void this.wireBot(entry);
    }
  }

  /** Start all registered bots. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    logger.info({ botCount: this.bots.size }, 'BotRegistry: starting');
    for (const entry of this.bots.values()) {
      await this.wireBot(entry);
    }
    logger.info('BotRegistry: all bots wired');
  }

  /** Stop all polling loops. Resolves once all loops have exited. */
  async stop(): Promise<void> {
    logger.info('BotRegistry: stopping');
    for (const entry of this.bots.values()) {
      if (entry.abortController) {
        entry.abortController.abort();
        logger.debug({ botId: entry.botId }, 'BotRegistry: aborted polling for bot');
      }
    }
    // Give polling loops up to 2 seconds to drain
    let waited = 0;
    while (waited < 2000) {
      const anyActive = Array.from(this.bots.values()).some(e => e.pollingActive);
      if (!anyActive) break;
      await new Promise(r => setTimeout(r, 100));
      waited += 100;
    }
    logger.info('BotRegistry: stopped');
  }

  /** Called by webhook routes to dispatch an incoming update to the correct handler. */
  async dispatch(botId: number | 'manager', update: Update): Promise<void> {
    const entry = this.bots.get(botId);
    if (!entry) {
      logger.warn({ botId }, 'BotRegistry.dispatch: no handler registered for bot');
      return;
    }
    try {
      await entry.handler(update);
    } catch (err) {
      logger.error({ err, botId, updateId: update.update_id }, 'BotRegistry.dispatch: handler threw');
    }
  }

  private async wireBot(entry: BotEntry): Promise<void> {
    if (entry.updateMode === 'polling') {
      await this.startPolling(entry);
    } else {
      await this.setupWebhook(entry);
    }
  }

  private async setupWebhook(entry: BotEntry): Promise<void> {
    if (!entry.webhookUrl || !entry.webhookSecret) {
      logger.error({ botId: entry.botId }, 'BotRegistry: webhook mode requires webhookUrl and webhookSecret');
      return;
    }
    try {
      await TelegramApiClient.setWebhook(entry.token, entry.webhookUrl, entry.allowedUpdates, entry.webhookSecret);
      logger.info({ botId: entry.botId, webhookUrl: entry.webhookUrl }, 'BotRegistry: webhook set');
    } catch (err) {
      logger.error({ err, botId: entry.botId }, 'BotRegistry: setWebhook failed');
    }
  }

  private async startPolling(entry: BotEntry): Promise<void> {
    // Remove any existing webhook
    try {
      await TelegramApiClient.deleteWebhook(entry.token);
      logger.info({ botId: entry.botId }, 'BotRegistry: webhook deleted for polling mode');
    } catch (err) {
      logger.warn({ err, botId: entry.botId }, 'BotRegistry: deleteWebhook failed (continuing)');
    }

    // Load persisted offset
    let offset = entry.initialOffset ?? 0;
    if (entry.botId === 'manager') {
      const stored = await appStateQueries.getAppState('manager_polling_offset');
      if (stored) offset = parseInt(stored, 10);
    }

    const ac = new AbortController();
    entry.abortController = ac;
    entry.pollingActive = true;

    logger.info({ botId: entry.botId, offset }, 'BotRegistry: starting polling loop');

    void (async () => {
      while (!ac.signal.aborted) {
        try {
          const updates = await TelegramApiClient.getUpdates(
            entry.token,
            offset,
            25,
            entry.allowedUpdates,
            ac.signal,
          );

          for (const update of updates) {
            try {
              await entry.handler(update);
            } catch (err) {
              logger.error({ err, botId: entry.botId, updateId: update.update_id }, 'BotRegistry: handler error for update');
            }
            // Advance offset regardless of handler success — prevents infinite retry of bad updates
            offset = update.update_id + 1;
            await this.persistOffset(entry.botId, offset);
          }
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') {
            logger.info({ botId: entry.botId }, 'BotRegistry: polling loop aborted');
            break;
          }
          logger.error({ err, botId: entry.botId }, 'BotRegistry: polling error, retrying in 5s');
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      entry.pollingActive = false;
      logger.info({ botId: entry.botId }, 'BotRegistry: polling loop exited');
    })();
  }

  private async persistOffset(botId: number | 'manager', offset: number): Promise<void> {
    try {
      if (botId === 'manager') {
        await appStateQueries.setAppState('manager_polling_offset', String(offset));
      } else {
        await managedBotQueries.savePollingOffset(botId, offset);
      }
    } catch (err) {
      logger.warn({ err, botId, offset }, 'BotRegistry: failed to persist offset (non-fatal)');
    }
  }
}
