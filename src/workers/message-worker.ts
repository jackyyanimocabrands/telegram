import { Worker } from 'bullmq';
import { logger } from '../utils/logger.js';
import { releaseLock } from '../services/conversation-lock.js';
import { processManagerMessage } from '../services/manager-bot.js';
import { processChildBotMessage } from '../services/child-bot.js';
import type { TelegramClient } from '../services/telegram-api.js';
import type { AgentService } from '../services/agent.js';
import type { ManagerMessageJobData, ChildMessageJobData } from '../queues/types.js';
import { env } from '../config/env.js';

export interface WorkerDeps {
  telegram: TelegramClient;
  agentService: AgentService;
  managerBotToken: string;
  managerBotId: string;
  baseUrl: string;
  botUsername: string;
}

export function createMessageWorkers(deps: WorkerDeps): {
  managerWorker: Worker;
  childWorker: Worker;
  close: () => Promise<void>;
} {
  const connection = { url: env.REDIS_URL };

  const managerWorker = new Worker<ManagerMessageJobData>(
    'manager-messages',
    async (job) => {
      const { conversationId } = job.data;
      logger.info({ jobId: job.id, conversationId }, 'managerWorker: processing job');
      try {
        await processManagerMessage(
          job.data,
          deps.telegram,
          deps.agentService,
          deps.managerBotToken,
          deps.managerBotId,
          deps.baseUrl,
          deps.botUsername,
        );
        logger.info({ jobId: job.id, conversationId }, 'managerWorker: job complete');
      } finally {
        await releaseLock(conversationId).catch((err) => {
          logger.warn({ err, conversationId }, 'managerWorker: failed to release lock');
        });
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY },
  );

  const childWorker = new Worker<ChildMessageJobData>(
    'child-messages',
    async (job) => {
      const { conversationId } = job.data;
      logger.info({ jobId: job.id, conversationId }, 'childWorker: processing job');
      try {
        await processChildBotMessage(job.data, deps.telegram, deps.agentService);
        logger.info({ jobId: job.id, conversationId }, 'childWorker: job complete');
      } finally {
        await releaseLock(conversationId).catch((err) => {
          logger.warn({ err, conversationId }, 'childWorker: failed to release lock');
        });
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY },
  );

  managerWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, conversationId: job?.data.conversationId, err }, 'managerWorker: job failed (log and drop)');
  });

  childWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, conversationId: job?.data.conversationId, err }, 'childWorker: job failed (log and drop)');
  });

  const close = async (): Promise<void> => {
    logger.info('Closing BullMQ workers...');
    await Promise.all([managerWorker.close(), childWorker.close()]);
    logger.info('BullMQ workers closed');
  };

  return { managerWorker, childWorker, close };
}
