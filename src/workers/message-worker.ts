import { Worker } from 'bullmq';
import { logger } from '../utils/logger.js';
import { releaseLock } from '../services/conversation-lock.js';
import { processManagerMessage } from '../services/manager-bot.js';
import { markNotified, getToken } from '../db/queries/email-verification-tokens.js';
import { EMAIL_VERIFICATION_QUEUE_NAME } from '../queues/email-verification-queue.js';
import type { TelegramClient } from '../services/telegram-api.js';
import type { AgentService } from '../services/agent.js';
import type { ManagerMessageJobData, EmailVerificationNotificationJobData } from '../queues/types.js';
import { env } from '../config/env.js';

export interface WorkerDeps {
  telegram: TelegramClient;
  agentService: AgentService;
  managerBotToken: string;
  managerBotId: string;
  baseUrl: string;
  botUsername: string;
}

// Escape all Telegram MarkdownV2 reserved characters in a plain string
function escapeMdV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, '\\$&');
}

// BLOCKER 11: extracted named export for testability
export async function processEmailVerificationJob(
  job: { data: EmailVerificationNotificationJobData; id?: string },
  deps: WorkerDeps,
): Promise<void> {
  const { botId, chatId, jti } = job.data;
  logger.info({ jobId: job.id, botId, chatId, jti }, 'emailVerificationWorker: processing');

  // BLOCKER 2: fetch email from DB at processing time — not stored in job payload
  const tokenRow = await getToken(jti);
  if (!tokenRow) {
    logger.warn({ jti }, 'processEmailVerificationJob: token not found in DB — already completed or deleted, skipping');
    return;
  }

  // BLOCKER 3: resolve the correct bot token based on botId
  let botToken: string;
  if (job.data.botId === deps.managerBotId) {
    botToken = deps.managerBotToken;
  } else {
    throw new Error(
      `processEmailVerificationJob: child bot token lookup not implemented for botId=${job.data.botId}. Implement getDecryptedBotToken lookup from token-store.ts before enabling child-bot email verification.`,
    );
  }

  // BLOCKER 3: escape email for MarkdownV2 before embedding
  const escapedEmail = escapeMdV2(tokenRow.email);

  // Send Telegram message FIRST — if this throws, markNotified is NOT called (job retried)
  await deps.telegram.sendMessage(
    botToken,
    chatId,
    `✅ Email *${escapedEmail}* verified\\. You now have access to additional tools\\.`,
    { parse_mode: 'MarkdownV2' },
  );
  const marked = await markNotified(jti);
  if (marked === 0) {
    logger.warn({ jti }, 'processEmailVerificationJob: markNotified was a no-op (already notified or race)');
    // Still consider this a success — user already got or will get the notification
  }
  logger.info({ jobId: job.id, jti }, 'emailVerificationWorker: notified');
}

export function createMessageWorkers(deps: WorkerDeps): {
  managerWorker: Worker;
  emailVerificationWorker: Worker;
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

  managerWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, conversationId: job?.data.conversationId, err }, 'managerWorker: job failed (log and drop)');
  });

  // BLOCKER 16: use EMAIL_WORKER_CONCURRENCY for email verification worker
  const emailVerificationWorker = new Worker<EmailVerificationNotificationJobData>(
    EMAIL_VERIFICATION_QUEUE_NAME,
    (job) => processEmailVerificationJob(job, deps),
    { connection, concurrency: env.EMAIL_WORKER_CONCURRENCY },
  );

  emailVerificationWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, jti: job?.data.jti, err }, 'emailVerificationWorker: job failed');
  });

  const close = async (): Promise<void> => {
    logger.info('Closing BullMQ workers...');
    await Promise.all([
      managerWorker.close(),
      emailVerificationWorker.close(),
    ]);
    logger.info('BullMQ workers closed');
  };

  return { managerWorker, emailVerificationWorker, close };
}
