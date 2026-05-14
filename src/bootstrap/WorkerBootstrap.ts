import { logger, fatalExit } from '../utils/logger.js';
import { pool, closePool } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { HttpTelegramClient } from '../services/telegram-api.js';
import { AgentService } from '../services/agent.js';
import { ConversationService } from '../services/conversation.js';
import { LlmProviderFactory } from '../services/llm/factory.js';
import { createMessageWorkers } from '../workers/message-worker.js';
import { env } from '../config/env.js';

export class WorkerBootstrap {
  private closeWorkers: (() => Promise<void>) | null = null;

  async start(): Promise<void> {
    try {
      logger.info('Worker: running database migrations...');
      await runMigrations();

      const result = await pool.query('SELECT NOW() AS now');
      logger.info({ time: result.rows[0]?.now }, 'Worker: database connected');

      const telegram = new HttpTelegramClient();
      const factory = new LlmProviderFactory();
      const conversationService = new ConversationService();
      const agentService = new AgentService(conversationService, factory as any);

      const { close } = createMessageWorkers({
        telegram,
        agentService,
        managerBotToken: env.BOT_TOKEN,
        managerBotId: 'manager',
        baseUrl: env.BASE_URL,
        botUsername: env.BOT_USERNAME,
      });

      this.closeWorkers = close;
      this._registerShutdownHandlers();

      logger.info(
        { concurrency: env.WORKER_CONCURRENCY },
        'Worker: BullMQ workers started (manager-messages, email-verification-notifications)',
      );
    } catch (err) {
      logger.fatal({ err }, 'Worker: failed to start');
      fatalExit(1);
    }
  }

  async stop(signal = 'manual'): Promise<void> {
    logger.info({ signal }, 'Worker: shutdown signal received');
    if (this.closeWorkers) {
      await this.closeWorkers();
    }
    await closePool().catch((err) => logger.error({ err }, 'Worker: error closing DB pool'));
  }

  private _registerShutdownHandlers(): void {
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const forceExit = setTimeout(() => {
        logger.error('Worker: forced shutdown after timeout');
        fatalExit(1);
      }, 30_000);
      forceExit.unref();
      await this.stop(signal);
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  }
}
