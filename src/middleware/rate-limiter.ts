import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger.js';
import type { Request, Response } from 'express';

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
  handler: (req: Request, res: Response) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Rate limit hit: auth');
    res.status(429).json({ ok: false, error: 'Too many requests, please try again later', code: 'RATE_LIMITED' });
  },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests', code: 'RATE_LIMITED' },
  handler: (req: Request, res: Response) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Rate limit hit: api');
    res.status(429).json({ ok: false, error: 'Too many requests', code: 'RATE_LIMITED' });
  },
});

export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many webhook requests', code: 'RATE_LIMITED' },
  handler: (req: Request, res: Response) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Rate limit hit: webhook');
    res.status(429).json({ ok: false, error: 'Too many webhook requests', code: 'RATE_LIMITED' });
  },
});

// TODO: For multi-process deployments, replace MemoryStore with a Redis-backed store
// (e.g. rate-limit-redis) to enforce limits across all instances.
export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,                    // 15 req / 15 min per IP — strict for admin
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
  handler: (req: Request, res: Response) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Rate limit hit: admin');
    res.status(429).json({ error: 'Too many requests' });
  },
});
