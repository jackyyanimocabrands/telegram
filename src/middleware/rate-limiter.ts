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
