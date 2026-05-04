import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  }),
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

/**
 * Flush the logger then exit. Required when using pino-pretty transport
 * (runs in a worker thread) — process.exit() without flush drops buffered logs.
 */
export function fatalExit(code: number = 1): void {
  logger.flush(() => process.exit(code));
}
