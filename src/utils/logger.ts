import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';

// Ensure log directory exists before pino opens the file
const logDir = path.resolve(env.LOG_DIR);
fs.mkdirSync(logDir, { recursive: true });

// Log file: rolling name by date, e.g. logs/2026-05-12.log
const today = new Date().toISOString().slice(0, 10);
const logFile = path.join(logDir, `${today}.log`);

const isDev = env.NODE_ENV !== 'production';

// Dual transport:
//   1. Console — pino-pretty (colorized) in dev, raw JSON in production
//   2. File    — always raw JSON (append), one file per day
export const logger = pino(
  {
    level: env.LOG_LEVEL,
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
  },
  pino.transport({
    targets: [
      // ── Console ──────────────────────────────────────────────────────────
      isDev
        ? {
            target: 'pino-pretty',
            level: env.LOG_LEVEL,
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname',
              singleLine: true,
              destination: 1, // stdout
            },
          }
        : {
            target: 'pino/file',
            level: env.LOG_LEVEL,
            options: { destination: 1 }, // stdout raw JSON in production
          },
      // ── File (raw JSON, append) ───────────────────────────────────────────
      {
        target: 'pino/file',
        level: env.LOG_LEVEL,
        options: {
          destination: logFile,
          append: true,
          mkdir: true,
        },
      },
    ],
  }),
);

/**
 * Flush the logger then exit.
 */
export function fatalExit(code: number = 1): void {
  logger.flush(() => process.exit(code));
}
