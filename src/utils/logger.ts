import pino from 'pino';
import pretty from 'pino-pretty';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';

// Ensure log directory exists before opening the file stream
const logDir = path.resolve(env.LOG_DIR);
fs.mkdirSync(logDir, { recursive: true });

// One log file per day, e.g. logs/2026-05-12.log
const today = new Date().toISOString().slice(0, 10);
const logFile = path.join(logDir, `${today}.log`);

const isDev = env.NODE_ENV !== 'production';

// ── Stream 1: Console ────────────────────────────────────────────────────────
// Dev  → pino-pretty (colorized, human-readable)
// Prod → raw JSON to stdout
const consoleStream = isDev
  ? pretty({
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
      singleLine: true,
      destination: process.stdout,
    })
  : process.stdout;

// ── Stream 2: File (raw JSON, append) ────────────────────────────────────────
const fileStream = fs.createWriteStream(logFile, { flags: 'a' });

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
  pino.multistream([
    { stream: consoleStream, level: env.LOG_LEVEL },
    { stream: fileStream,    level: env.LOG_LEVEL },
  ]),
);

/**
 * Flush the logger then exit.
 */
export function fatalExit(code: number = 1): void {
  logger.flush(() => process.exit(code));
}
