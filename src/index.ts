import express from 'express';
import cors from 'cors';
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
import { handleChildBotMessage, handleChildBotCallback } from './services/child-bot.js';
import { getDecryptedBotToken } from './services/token-store.js';
import * as managedBotQueries from './db/queries/managed-bots.js';

const app = express();

// Trust the first proxy (ngrok, Cloudflare, load balancer, etc.)
app.set('trust proxy', 1);

// CORS — configurable origins
const corsOrigins = getCorsOrigins();
app.use(cors({
  origin: corsOrigins ?? true,
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

async function start(): Promise<void> {
  try {
    logger.info('Running database migrations...');
    await runMigrations();
    logger.info('Migrations applied successfully');

    const result = await pool.query('SELECT NOW() AS now');
    logger.info({ time: result.rows[0]?.now }, 'Database connected');

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
        updateMode: (bot.update_mode as 'polling' | 'webhook') ?? 'webhook',
        allowedUpdates: ['message', 'callback_query'],
        webhookUrl: `${env.BASE_URL}/webhook/bot/${bot.bot_id}`,
        webhookSecret: env.CHILD_WEBHOOK_SECRET,
        initialOffset: bot.polling_offset ?? 0,
        handler: async (update) => {
          if (update.message) await handleChildBotMessage(bot.bot_id, update.message);
          else if (update.callback_query) await handleChildBotCallback(bot.bot_id, update.callback_query);
        },
      });
    }

    // Start the registry (wires all transports)
    await registry.start();

    // Wire routes now that registry is ready
    app.use(healthRouter);
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
