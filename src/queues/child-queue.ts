import { Queue } from 'bullmq';
import type { ChildMessageJobData } from './types.js';
import { env } from '../config/env.js';

export const childQueue = new Queue<ChildMessageJobData>('child-messages', {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: env.JOB_RETENTION_HOURS * 3600 },
    removeOnFail: { age: env.JOB_RETENTION_HOURS * 3600 },
  },
});
