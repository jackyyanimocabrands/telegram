import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env, getCorsOrigins } from '../config/env.js';
import { logger, fatalExit } from '../utils/logger.js';
import { pool, closePool } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { healthRouter } from '../routes/health.js';
import { authRouter } from '../routes/auth.js';
import { createWebhookRouter } from '../routes/webhook.js';
import { botStatusRouter } from '../routes/bot-status.js';
import { errorHandler } from '../middleware/error-handler.js';
import { adminRouter } from '../routes/admin.js';
import { authLimiter, webhookLimiter, apiLimiter, adminLimiter, verifyEmailLimiter } from '../middleware/rate-limiter.js';
import { BotRegistry } from '../services/bot-registry.js';
import { HttpTelegramClient } from '../services/telegram-api.js';
import * as managedBotQueries from '../db/queries/managed-bots.js';
import { enqueueManagerMessage } from '../services/manager-bot.js';
import { managerQueue } from '../queues/manager-queue.js';
import { getEmailVerificationQueue } from '../queues/email-verification-queue.js';
import { createVerifyEmailRouter } from '../routes/verify-email.js';

export class AppBootstrap {
  private app: express.Application;
  private server: http.Server | null = null;
  private registry: BotRegistry | null = null;

  constructor() {
    this.app = express();
    this._configureMiddleware();
  }

  private _configureMiddleware(): void {
    // Trust the first proxy (ngrok, Cloudflare, load balancer, etc.)
    this.app.set('trust proxy', 1);

    // Security headers — FIRST middleware so every response is hardened before
    // CORS, body parsing, or any route handler runs.
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://telegram.org', 'https://*.telegram.org'],
          frameSrc: ["'self'", 'https://telegram.org', 'https://*.telegram.org'],
          connectSrc: ["'self'", 'https://telegram.org', 'https://*.telegram.org'],
          imgSrc: ["'self'", 'data:', 'https://t.me', 'https://*.telegram.org'],
          fontSrc: ["'self'", 'https://telegram.org', 'https://*.telegram.org'],
        },
      },
    }));

    const corsOrigins = getCorsOrigins();

    if (env.NODE_ENV === 'production' && corsOrigins !== null && corsOrigins.length === 0) {
      logger.warn('CORS_ORIGINS is not set — all cross-origin requests will be denied in production');
    }

    this.app.use(cors({
      origin: corsOrigins ?? true,
      credentials: true,
    }));

    this.app.use(express.json({ limit: '1mb' }));
    this.app.use('/public', express.static('public'));
  }

  async start(): Promise<void> {
    try {
      logger.info('Running database migrations...');
      await runMigrations();
      logger.info('Migrations applied successfully');

      const result = await pool.query('SELECT NOW() AS now');
      logger.info({ time: result.rows[0]?.now }, 'Database connected');

      // On startup, mark stale PENDING/PROVISIONING rows as DEACTIVATED.
      const staleCount = await managedBotQueries.deactivateStalePendingBots(5);
      if (staleCount > 0) {
        logger.warn({ count: staleCount }, 'Deactivated stale PENDING/PROVISIONING bots at startup');
      }

      // ── BotRegistry setup ──
      const telegram = new HttpTelegramClient();
      this.registry = new BotRegistry(telegram);

      // Register manager bot
      this.registry.registerBot({
        botId: 'manager',
        token: env.BOT_TOKEN,
        updateMode: env.MANAGER_UPDATE_MODE,
        allowedUpdates: ['message', 'managed_bot'],
        webhookUrl: `${env.BASE_URL}/webhook/telegram`,
        webhookSecret: env.WEBHOOK_SECRET,
        handler: async (update) => {
          if (update.message) {
            await enqueueManagerMessage(
              update.message,
              telegram,
              env.BOT_TOKEN,
              env.BOT_USERNAME,
            );
          } else {
            logger.debug({ updateId: update.update_id }, 'Manager bot: unhandled update type, ignoring');
          }
        },
      });

      // Health check — registered BEFORE rate limiters; must always be reachable.
      this.app.use(healthRouter);

      // BLOCKER 17: eagerly init email verification queue at startup to warm the Redis connection
      getEmailVerificationQueue();

      // Public routes — mounted BEFORE auth middleware
      this.app.use('/verify-email', verifyEmailLimiter, createVerifyEmailRouter());

      // Start the registry (wires all transports)
      await this.registry.start();

      // Wire remaining routes after the registry is ready
      this.app.use('/api/auth', authLimiter, authRouter);
      this.app.use('/api/bots', apiLimiter, botStatusRouter);
      this.app.use('/webhook', webhookLimiter, createWebhookRouter(this.registry));
      this.app.use('/admin', adminLimiter, adminRouter);
      this.app.use(errorHandler);

      await new Promise<void>((resolve, reject) => {
        this.server = this.app.listen(env.PORT, env.HOST, () => {
          logger.info(
            { port: env.PORT, host: env.HOST, env: env.NODE_ENV, corsOrigins: getCorsOrigins() },
            'Server listening',
          );
          resolve();
        });

        this.server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            logger.fatal({ port: env.PORT, host: env.HOST }, `Port ${env.PORT} is already in use. Exiting.`);
          } else {
            logger.fatal({ err }, 'Server failed to start');
          }
          reject(err);
        });
      });

      this._registerShutdownHandlers();
    } catch (err) {
      logger.fatal({ err }, 'Failed to start server');
      fatalExit(1);
    }
  }

  async stop(signal = 'manual'): Promise<void> {
    logger.info({ signal }, 'Shutdown signal received');
    if (this.registry) {
      await this.registry.stop();
    }
    await managerQueue.close().catch((err) => {
      logger.error({ err }, 'Error closing BullMQ queues');
    });
    // BLOCKER 4: close email verification queue on shutdown
    await getEmailVerificationQueue().close().catch((err) => {
      logger.error({ err }, 'Error closing email verification queue');
    });
    await new Promise<void>((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(async () => {
        logger.info('HTTP server closed');
        try {
          await closePool();
        } catch (err) {
          logger.error({ err }, 'Error closing DB pool');
        }
        resolve();
      });
      // Forcibly drain keep-alive connections so server.close() callback fires promptly.
      this.server.closeAllConnections();
    });
  }

  private _registerShutdownHandlers(): void {
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;

      // Force-exit timer starts only once a shutdown signal is received
      const forceExit = setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        fatalExit(1);
      }, 10_000);
      forceExit.unref();

      await this.stop(signal);
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  }
}
