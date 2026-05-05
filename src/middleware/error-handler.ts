import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    logger.warn(
      { err, statusCode: err.statusCode, code: err.code, method: req.method, path: req.path, ip: req.ip },
      'Operational error',
    );
    // Do not leak internal error details (e.g. Telegram method names) to HTTP clients.
    const message = err.isClientFacing !== false ? err.message : 'An internal error occurred';
    res.status(err.statusCode).json({
      ok: false,
      error: message,
      code: err.code,
    });
    return;
  }

  logger.error({ err, method: req.method, path: req.path, ip: req.ip }, 'Unhandled error');

  res.status(500).json({
    ok: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
}
