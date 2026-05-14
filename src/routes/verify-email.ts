import { Router, type IRouter } from 'express';
import { verifyVerificationToken } from '../services/email-verification.js';
import { updateToolsetState } from '../db/queries/conversations.js';
import { getRedisClient } from '../services/redis.js';
import { logger } from '../utils/logger.js';

export const verifyEmailRouter: IRouter = Router();

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Email Verified</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:12px;padding:2.5rem;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#16a34a;margin-bottom:.5rem}p{color:#6b7280;margin:0}</style></head>
<body><div class="card"><h1>✓ Email verified</h1><p>You can now return to the bot. Your tools are unlocked.</p></div></body>
</html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Verification Failed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:12px;padding:2.5rem;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#dc2626;margin-bottom:.5rem}p{color:#6b7280;margin:0}</style></head>
<body><div class="card"><h1>✗ Verification failed</h1><p>This link is invalid or has expired. Please request a new verification email from the bot.</p></div></body>
</html>`;

const ALREADY_USED_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Already Verified</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:12px;padding:2.5rem;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#dc2626;margin-bottom:.5rem}p{color:#6b7280;margin:0}</style></head>
<body><div class="card"><h1>✗ Link already used</h1><p>This verification link has already been used. Please request a new verification email from the bot.</p></div></body>
</html>`;

const SERVER_ERROR_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Server Error</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:12px;padding:2.5rem;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#dc2626;margin-bottom:.5rem}p{color:#6b7280;margin:0}</style></head>
<body><div class="card"><h1>✗ Server error</h1><p>Something went wrong. Please try again later.</p></div></body>
</html>`;

// GET /verify-email?token=<jwt>
verifyEmailRouter.get('/', async (req, res) => {
  const token = req.query.token;

  if (typeof token !== 'string' || token.length === 0) {
    logger.debug('verifyEmailRouter: missing token query param');
    res.status(400).type('html').send(ERROR_HTML);
    return;
  }

  let payload: { email: string; botId: string; userId: string; jti: string; exp: number };
  try {
    payload = verifyVerificationToken(token);
  } catch (err) {
    logger.debug({ err }, 'verifyEmailRouter: invalid or expired token');
    res.status(400).type('html').send(ERROR_HTML);
    return;
  }

  // Basic botId validation
  if (!payload.botId || typeof payload.botId !== 'string') {
    logger.warn({ botId: payload.botId }, 'verifyEmailRouter: missing or invalid botId in token');
    res.status(400).type('html').send(ERROR_HTML);
    return;
  }

  // userId stored in JWT is the telegram user id (number as string)
  const telegramUserId = Number(payload.userId);
  if (!Number.isFinite(telegramUserId)) {
    logger.warn({ userId: payload.userId }, 'verifyEmailRouter: non-numeric userId in token');
    res.status(400).type('html').send(ERROR_HTML);
    return;
  }

  // JWT replay protection — mark jti as used atomically in Redis
  const redis = getRedisClient();
  const jtiKey = `email-verify:used:${payload.jti}`;
  const remainingMs = Math.max(1, (payload.exp * 1000) - Date.now());
  const already = await redis.set(jtiKey, '1', 'PX', remainingMs, 'NX');
  if (already === null) {
    // Key already existed — token already used
    logger.warn({ jti: payload.jti, email: payload.email }, 'verifyEmailRouter: token already used (replay attempt)');
    res.status(400).type('html').send(ALREADY_USED_HTML);
    return;
  }

  try {
    const updated = await updateToolsetState(payload.botId, telegramUserId, {
      email: payload.email,
      email_verified: true,
    });
    if (updated === 0) {
      logger.warn({ botId: payload.botId, telegramUserId }, 'verify-email: no conversation row found for this botId/userId');
      // Graceful degradation: user is verified, conversation may not exist yet
    }
    logger.info({ email: payload.email, botId: payload.botId, userId: payload.userId }, 'verifyEmailRouter: email verified and toolset state updated');
    res.status(200).type('html').send(SUCCESS_HTML);
  } catch (err) {
    logger.error({ err, email: payload.email, botId: payload.botId, userId: payload.userId }, 'verifyEmailRouter: DB error updating toolset state');
    res.status(500).type('html').send(SERVER_ERROR_HTML);
  }
});
