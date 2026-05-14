import { Router, type Router as RouterType } from 'express';
import { pool } from '../db/client.js';
import {
  getTokenUsageSummary,
  getConversationTokenUsage,
  getBotTokenUsage,
  type TokenUsageSummaryFilters,
  type TokenUsageRawFilters,
} from '../db/queries/token-usage.js';
import { adminAuth } from '../middleware/admin-auth.js';
import { logger } from '../utils/logger.js';

export const adminRouter: RouterType = Router();

// All admin routes require Bearer token auth
adminRouter.use(adminAuth);

/**
 * Parse an optional ISO date string query param.
 * Returns the Date on success, null if absent, or undefined to signal a 400.
 */
function parseDateParam(value: unknown): Date | null | undefined {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  if (isNaN(date.getTime())) return undefined;
  return date;
}

/**
 * Parse an optional positive integer limit from a query param.
 * Returns a value clamped to [1, 5000], or undefined when absent/invalid.
 */
function parseLimitParam(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0) return undefined;
  return Math.min(n, 5000);
}

/**
 * GET /admin/token-usage/summary
 * Query: provider?, model?, from?, to?
 */
adminRouter.get('/token-usage/summary', async (req, res) => {
  try {
    const { provider, model } = req.query;

    const fromDate = parseDateParam(req.query.from);
    const toDate = parseDateParam(req.query.to);

    if (fromDate === undefined) {
      res.status(400).json({ error: 'Invalid "from" date' });
      return;
    }
    if (toDate === undefined) {
      res.status(400).json({ error: 'Invalid "to" date' });
      return;
    }

    const filters: TokenUsageSummaryFilters = {};
    if (typeof provider === 'string' && provider) filters.provider = provider;
    if (typeof model === 'string' && model) filters.model = model;

    // E2 — default to last 90 days when no date filter provided
    const effectiveFrom =
      fromDate !== null ? fromDate : toDate !== null ? undefined : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const effectiveTo = toDate !== null ? toDate : undefined;

    if (effectiveFrom !== undefined) filters.from = effectiveFrom;
    if (effectiveTo !== undefined) filters.to = effectiveTo;

    const rows = await getTokenUsageSummary(pool, filters);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'GET /admin/token-usage/summary failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /admin/token-usage/conversation/:botId/:userId
 * Params: botId (string), userId (number - telegram_user_id)
 * Query: from?, to?, limit?
 */
adminRouter.get('/token-usage/conversation/:botId/:userId', async (req, res) => {
  try {
    const { botId, userId: userIdStr } = req.params;

    // E1 — guard non-empty botId
    if (!botId) {
      res.status(400).json({ error: 'botId is required' });
      return;
    }

    const userId = parseInt(userIdStr, 10);
    if (isNaN(userId)) {
      res.status(400).json({ error: 'Invalid userId — must be a number' });
      return;
    }

    const fromDate = parseDateParam(req.query.from);
    const toDate = parseDateParam(req.query.to);

    if (fromDate === undefined) {
      res.status(400).json({ error: 'Invalid "from" date' });
      return;
    }
    if (toDate === undefined) {
      res.status(400).json({ error: 'Invalid "to" date' });
      return;
    }

    // E3 — parse limit
    const limit = parseLimitParam(req.query.limit);

    const filters: TokenUsageRawFilters = {};
    if (fromDate !== null) filters.from = fromDate;
    if (toDate !== null) filters.to = toDate;
    if (limit !== undefined) filters.limit = limit;

    const rows = await getConversationTokenUsage(pool, botId, userId, filters);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'GET /admin/token-usage/conversation/:botId/:userId failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /admin/token-usage/bot/:botId
 * Params: botId (string)
 * Query: from?, to?, limit?
 */
adminRouter.get('/token-usage/bot/:botId', async (req, res) => {
  try {
    const { botId } = req.params;

    // E1 — guard non-empty botId
    if (!botId) {
      res.status(400).json({ error: 'botId is required' });
      return;
    }

    const fromDate = parseDateParam(req.query.from);
    const toDate = parseDateParam(req.query.to);

    if (fromDate === undefined) {
      res.status(400).json({ error: 'Invalid "from" date' });
      return;
    }
    if (toDate === undefined) {
      res.status(400).json({ error: 'Invalid "to" date' });
      return;
    }

    // E3 — parse limit
    const limit = parseLimitParam(req.query.limit);

    const filters: TokenUsageRawFilters = {};
    if (fromDate !== null) filters.from = fromDate;
    if (toDate !== null) filters.to = toDate;
    if (limit !== undefined) filters.limit = limit;

    const rows = await getBotTokenUsage(pool, botId, filters);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'GET /admin/token-usage/bot/:botId failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
