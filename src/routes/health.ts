import { Router, type Router as RouterType } from 'express';
import { logger } from '../utils/logger.js';

export const healthRouter: RouterType = Router();

healthRouter.get('/health', (_req, res) => {
  logger.debug('GET /health');
  res.json({ ok: true, service: 'animocamind-telegram-connector' });
});

healthRouter.get('/ready', async (_req, res) => {
  logger.debug('GET /ready: checking DB');
  try {
    const { pool } = await import('../db/client.js');
    const result = await pool.query('SELECT 1 AS ok');
    if (result.rows[0]?.ok === 1) {
      logger.debug('GET /ready: DB connected');
      res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
    } else {
      logger.warn({ row: result.rows[0] }, 'GET /ready: DB returned unexpected response');
      res.status(503).json({ status: 'error', db: 'unexpected response' });
    }
  } catch (err) {
    logger.error({ err }, 'GET /ready: DB unreachable');
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});
