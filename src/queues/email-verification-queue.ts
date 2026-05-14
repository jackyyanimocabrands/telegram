import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import type { EmailVerificationNotificationJobData } from './types.js';

export const EMAIL_VERIFICATION_QUEUE_NAME = 'email-verification-notifications';

let _queue: Queue<EmailVerificationNotificationJobData> | null = null;

export function getEmailVerificationQueue(): Queue<EmailVerificationNotificationJobData> {
  if (!_queue) {
    _queue = new Queue<EmailVerificationNotificationJobData>(EMAIL_VERIFICATION_QUEUE_NAME, {
      connection: { url: env.REDIS_URL },
      // BLOCKER 9: job options — retention, retry with exponential backoff
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    });
  }
  return _queue;
}
