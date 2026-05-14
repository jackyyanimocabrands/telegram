import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual, createHmac } from 'crypto';
import { env } from '../config/env.js';

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = authHeader.slice(7); // 'Bearer '.length === 7

  // Constant-time comparison via HMAC-SHA256 digests — normalizes both inputs to
  // a fixed 32-byte length (eliminates length oracle) then delegates to the
  // constant-time C implementation in crypto.timingSafeEqual.
  const hmacKey = Buffer.alloc(32); // static zero key — only for length normalization
  const tokenDigest = createHmac('sha256', hmacKey).update(Buffer.from(token)).digest();
  const keyDigest   = createHmac('sha256', hmacKey).update(Buffer.from(env.ADMIN_API_KEY)).digest();

  if (!timingSafeEqual(tokenDigest, keyDigest)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
