import { Router, type Router as RouterType } from 'express';
import { pool } from '../db/client.js';
import { logger } from '../utils/logger.js';

export const healthRouter: RouterType = Router();

/**
 * GET /health
 *
 * ECS / ALB health check endpoint. No authentication, no rate limiting.
 * Performs a lightweight DB liveness probe (SELECT 1).
 *
 * 200 → { status: "ok",    uptime: <seconds>, timestamp: "<ISO>" }
 * 503 → { status: "error", error:  "DB unavailable" }
 */
healthRouter.get('/health', async (_req, res) => {
  logger.debug('GET /health');
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'GET /health: DB probe failed');
    res.status(503).json({ status: 'error', error: 'DB unavailable' });
  }
});
