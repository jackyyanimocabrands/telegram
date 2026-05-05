import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env, getCorsOrigins } from './config/env.js';
import { logger, fatalExit } from './utils/logger.js';
import { pool, closePool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { createWebhookRouter } from './routes/webhook.js';
import { botStatusRouter } from './routes/bot-status.js';
import { errorHandler } from './middleware/error-handler.js';
import { authLimiter, webhookLimiter, apiLimiter } from './middleware/rate-limiter.js';
import { BotRegistry } from './services/bot-registry.js';
import { ManagedBotService } from './services/managed-bot.js';
import { createChildBotHandler } from './services/child-bot.js';
import { getDecryptedBotToken } from './services/token-store.js';
import * as managedBotQueries from './db/queries/managed-bots.js';

const app = express();

// Trust the first proxy (ngrok, Cloudflare, load balancer, etc.)
app.set('trust proxy', 1);

// B-3: Security headers — FIRST middleware so every response is hardened before
// CORS, body parsing, or any route handler runs.
app.use(helmet());

// CORS — configurable origins
const corsOrigins = getCorsOrigins();

// B-6: Warn operators in production when CORS_ORIGINS is not set.
// getCorsOrigins() returns [] (deny all) when NODE_ENV=production and CORS_ORIGINS is absent.
// This is intentionally strict but produces silent 403s — alert here so operators don't debug blindly.
if (env.NODE_ENV === 'production' && corsOrigins !== null && corsOrigins.length === 0) {
  logger.warn('CORS_ORIGINS is not set — all cross-origin requests will be denied in production');
}

app.use(cors({
  origin: corsOrigins ?? true,
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
// B-4: Mount static files under /public prefix — prevents files from shadowing routes at root
// and makes the intent explicit.
app.use('/public', express.static('public'));

async function start(): Promise<void> {
  try {
    logger.info('Running database migrations...');
    await runMigrations();
    logger.info('Migrations applied successfully');

    const result = await pool.query('SELECT NOW() AS now');
    logger.info({ time: result.rows[0]?.now }, 'Database connected');

    // C-02 Part 2: On startup, mark stale PENDING/PROVISIONING rows as DEACTIVATED.
    // These indicate a crashed provisioning flow; they must be cleaned up before the
    // registry starts so they don't block retry via the same update_id dedup logic.
    const staleResult = await pool.query<{ bot_id: number; status: string }>(
      `UPDATE managed_bots
       SET status = 'DEACTIVATED', updated_at = NOW()
       WHERE status IN ('PENDING', 'PROVISIONING')
         AND updated_at < NOW() - INTERVAL '5 minutes'
       RETURNING bot_id, status`,
    );
    if (staleResult.rowCount && staleResult.rowCount > 0) {
      for (const row of staleResult.rows) {
        logger.warn({ botId: row.bot_id, previousStatus: row.status }, 'startup: stale provisioning row deactivated');
      }
    }

    // ── BotRegistry setup ──
    const registry = new BotRegistry();
    const managedBotService = new ManagedBotService(registry);

    // Register manager bot
    registry.registerBot({
      botId: 'manager',
      token: env.BOT_TOKEN,
      updateMode: env.MANAGER_UPDATE_MODE,
      allowedUpdates: ['message', 'managed_bot'],
      webhookUrl: `${env.BASE_URL}/webhook/telegram`,
      webhookSecret: env.WEBHOOK_SECRET,
      handler: async (update) => {
        if (update.managed_bot) {
          logger.info({ updateId: update.update_id, botId: update.managed_bot.bot?.id }, 'Processing managed_bot update');
          await managedBotService.handleManagedBotUpdated(update.update_id, update.managed_bot);
        } else if (update.message) {
          logger.info(
            { updateId: update.update_id, from: update.message.from?.id, text: update.message.text },
            'Manager bot received message',
          );
        } else {
          logger.debug({ updateId: update.update_id }, 'Manager bot: unhandled update type, ignoring');
        }
      },
    });

    // Load all ACTIVE child bots from DB and register them
    const activeBots = await managedBotQueries.findAllActiveManagedBots();
    logger.info({ count: activeBots.length }, 'Loading active child bots');
    for (const bot of activeBots) {
      let token: string;
      try {
        token = await getDecryptedBotToken(bot.bot_id);
      } catch (err) {
        logger.error({ err, botId: bot.bot_id }, 'Failed to decrypt token for active bot, skipping');
        continue;
      }
      registry.registerBot({
        botId: bot.bot_id,
        token,
        updateMode: (bot.update_mode ?? 'webhook') as 'polling' | 'webhook',
        allowedUpdates: ['message', 'callback_query'],
        webhookUrl: `${env.BASE_URL}/webhook/bot/${bot.bot_id}`,
        webhookSecret: env.CHILD_WEBHOOK_SECRET,
        initialOffset: bot.polling_offset ?? 0,
        handler: createChildBotHandler(bot.bot_id),
      });
    }

    // ── Health check — registered BEFORE auth middleware and rate limiters ──
    // ECS / ALB probes hit /health; it must always be reachable, unauthenticated,
    // and never subject to the apiLimiter applied to business routes below.
    app.use(healthRouter);

    // Start the registry (wires all transports)
    await registry.start();

    // Wire remaining routes after the registry is ready
    app.use('/api/auth', authLimiter, authRouter);
    app.use('/api/bots', apiLimiter, botStatusRouter);
    app.use('/webhook', webhookLimiter, createWebhookRouter(registry));
    app.use(errorHandler);

    const server = app.listen(env.PORT, env.HOST, () => {
      logger.info({ port: env.PORT, host: env.HOST, env: env.NODE_ENV, corsOrigins }, 'Server listening');
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.fatal({ port: env.PORT, host: env.HOST }, `Port ${env.PORT} is already in use. Exiting.`);
      } else {
        logger.fatal({ err }, 'Server failed to start');
      }
      fatalExit(1);
    });

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received');
      await registry.stop();
      server.close(async () => {
        logger.info('HTTP server closed');
        try {
          await closePool();
        } catch (err) {
          logger.error({ err }, 'Error closing DB pool');
        }
        process.exit(0);
      });
      // M-10: Forcibly drain keep-alive connections so server.close() callback fires promptly.
      server.closeAllConnections();
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        fatalExit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    fatalExit(1);
  }
}

start();
