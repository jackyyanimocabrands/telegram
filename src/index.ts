import express from 'express';
import cors from 'cors';
import { env, getCorsOrigins } from './config/env.js';
import { logger, fatalExit } from './utils/logger.js';
import { pool, closePool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { webhookRouter } from './routes/webhook.js';
import { botStatusRouter } from './routes/bot-status.js';
import { errorHandler } from './middleware/error-handler.js';
import { authLimiter, webhookLimiter, apiLimiter } from './middleware/rate-limiter.js';

const app = express();

// Trust the first proxy (ngrok, Cloudflare, load balancer, etc.)
app.set('trust proxy', 1);

// CORS — configurable origins
const corsOrigins = getCorsOrigins();
app.use(cors({
  origin: corsOrigins ?? true, // null = allow all (dev), otherwise whitelist
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

app.use(healthRouter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/bots', apiLimiter, botStatusRouter);
app.use('/webhook', webhookLimiter, webhookRouter);
app.use(errorHandler);

async function start(): Promise<void> {
  try {
    logger.info('Running database migrations...');
    await runMigrations();
    logger.info('Migrations applied successfully');

    const result = await pool.query('SELECT NOW() AS now');
    logger.info({ time: result.rows[0]?.now }, 'Database connected');

    const server = app.listen(env.PORT, env.HOST, () => {
      logger.info({ port: env.PORT, host: env.HOST, env: env.NODE_ENV, corsOrigins }, 'Server listening');
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.fatal({ port: env.PORT, host: env.HOST }, `Port ${env.PORT} is already in use — another process is listening on this port. Exiting.`);
      } else {
        logger.fatal({ err }, 'Server failed to start');
      }
      fatalExit(1);
    });

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received');
      server.close(async () => {
        logger.info('HTTP server closed');
        try {
          await closePool();
        } catch (err) {
          logger.error({ err }, 'Error closing DB pool');
        }
        process.exit(0);
      });
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        fatalExit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    fatalExit(1);
  }
}

start();
