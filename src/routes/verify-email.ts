import { Router, type IRouter } from 'express';
import { Queue } from 'bullmq';
import { verifyVerificationToken as verifyVerificationTokenFn } from '../services/email-verification.js';
import {
  updateToolsetState as updateToolsetStateQuery,
} from '../db/queries/conversations.js';
import {
  getToken as getTokenQuery,
  markVerifiedAtomic as markVerifiedAtomicQuery,
  extendExpiry as extendExpiryQuery,
} from '../db/queries/email-verification-tokens.js';
import { getEmailVerificationQueue } from '../queues/email-verification-queue.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { EmailVerificationNotificationJobData } from '../queues/types.js';
import type { EmailVerificationTokenRow } from '../db/queries/email-verification-tokens.js';

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Email Verified</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:12px;padding:2.5rem;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#16a34a;margin-bottom:.5rem}p{color:#6b7280;margin:0}</style></head>
<body><div class="card"><h1>✓ Email verified</h1><p>You can now return to the bot. Your tools are unlocked.</p></div></body>
</html>`;

const NO_CONVERSATION_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Email Verified</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:12px;padding:2.5rem;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#16a34a;margin-bottom:.5rem}p{color:#6b7280;margin:0}</style></head>
<body><div class="card"><h1>✓ Email verified</h1><p>Your email has been verified. Please send a message to the bot to complete setup.</p></div></body>
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

// ── Injectable deps interface (BLOCKER 9) ─────────────────────────────────

export interface VerifyEmailRouterDeps {
  getNow?: () => Date;
  queue?: Pick<Queue<EmailVerificationNotificationJobData>, 'add'>;
  getToken?: typeof getTokenQuery;
  markVerifiedAtomic?: typeof markVerifiedAtomicQuery;
  extendExpiry?: typeof extendExpiryQuery;
  updateToolsetState?: typeof updateToolsetStateQuery;
  verifyVerificationToken?: typeof verifyVerificationTokenFn;
  renewThresholdSecs?: number;
  ttlSecs?: number;
}

/**
 * Factory that creates the /verify-email router.
 * All DB and queue dependencies are injectable for testability.
 * In production, call with no arguments — all defaults are used.
 */
export function createVerifyEmailRouter(deps: VerifyEmailRouterDeps = {}): IRouter {
  const {
    getNow = () => new Date(),
    queue = getEmailVerificationQueue(),
    getToken: getTokenFn = getTokenQuery,
    markVerifiedAtomic: markVerifiedAtomicFn = markVerifiedAtomicQuery,
    extendExpiry: extendExpiryFn = extendExpiryQuery,
    updateToolsetState: updateToolsetStateFn = updateToolsetStateQuery,
    verifyVerificationToken: verifyTokenFn = verifyVerificationTokenFn,
    renewThresholdSecs = env.EMAIL_VERIFICATION_RENEW_THRESHOLD_SECS,
    ttlSecs = env.EMAIL_VERIFICATION_TOKEN_TTL_SECS,
  } = deps;

  const router = Router();

  // GET /verify-email?token=<jwt>
  router.get('/', async (req, res) => {
    const token = req.query.token;

    if (typeof token !== 'string' || token.length === 0) {
      logger.debug('verifyEmailRouter: missing token query param');
      res.status(400).type('html').send(ERROR_HTML);
      return;
    }

    let payload: { email: string; botId: string; userId: string; jti: string; exp: number };
    try {
      payload = verifyTokenFn(token, () => getNow().getTime());
    } catch (err) {
      logger.debug({ err }, 'verifyEmailRouter: invalid or expired token');
      res.status(400).type('html').send(ERROR_HTML);
      return;
    }

    // BLOCKER 7: removed redundant botId guard — verifyVerificationToken already throws if botId is invalid

    const telegramUserId = Number(payload.userId);
    if (!Number.isFinite(telegramUserId)) {
      logger.warn({ userId: payload.userId }, 'verifyEmailRouter: non-numeric userId in token');
      res.status(400).type('html').send(ERROR_HTML);
      return;
    }

    try {
      // 1. Load DB row
      const tokenRow: EmailVerificationTokenRow | null = await getTokenFn(payload.jti);

      if (!tokenRow) {
        logger.warn({ jti: payload.jti }, 'verifyEmailRouter: token not found in DB');
        res.status(400).type('html').send(ERROR_HTML);
        return;
      }

      const now = getNow();

      if (tokenRow.expires_at <= now) {
        logger.warn({ jti: payload.jti, expiresAt: tokenRow.expires_at }, 'verifyEmailRouter: token expired (DB)');
        res.status(400).type('html').send(ERROR_HTML);
        return;
      }

      if (tokenRow.status === 'notified') {
        logger.warn({ jti: payload.jti }, 'verifyEmailRouter: token already notified');
        res.status(400).type('html').send(ALREADY_USED_HTML);
        return;
      }

      // BLOCKER 6: cross-check JWT claims against DB row before any further processing
      if (
        tokenRow.bot_id !== payload.botId ||
        tokenRow.user_id !== telegramUserId ||
        tokenRow.email !== payload.email
      ) {
        logger.warn(
          { jti: payload.jti, dbBotId: tokenRow.bot_id, payloadBotId: payload.botId },
          'verifyEmailRouter: JWT claims do not match DB row — possible token substitution',
        );
        res.status(400).type('html').send(ERROR_HTML);
        return;
      }

      // BLOCKER 8: sliding expiry helper — used on re-click path only
      const computeNewExpiresAt = (currentExpiresAt: Date): Date => {
        const remainingMs = currentExpiresAt.getTime() - now.getTime();
        const thresholdMs = renewThresholdSecs * 1000;
        if (remainingMs < thresholdMs) {
          return new Date(now.getTime() + ttlSecs * 1000);
        }
        return currentExpiresAt;
      };

      if (tokenRow.status === 'pending') {
        // BLOCKER 2: no-op write removed — markVerifiedAtomic no longer accepts/passes expires_at
        // Atomic CAS: only succeeds if still 'pending'
        const updatedRow = await markVerifiedAtomicFn(payload.jti);

        if (!updatedRow) {
          // Race — another request already claimed the transition.
          // Return success immediately; the other request won the race and verification succeeded.
          logger.debug({ jti: payload.jti }, 'verifyEmailRouter: race — token already verified, returning success');
          res.status(200).type('html').send(SUCCESS_HTML);
          return;
        }

        // First verification: update toolset state
        const updated = await updateToolsetStateFn(payload.botId, telegramUserId, {
          email: payload.email,
          email_verified: true,
        });

        // BLOCKER 5: if no conversation row exists, skip the notification job —
        // the user hasn't started a conversation yet. Return a prompt to send a message.
        if (updated === 0) {
          logger.warn(
            { botId: payload.botId, telegramUserId },
            'verifyEmailRouter: no conversation row found for this botId/userId — skipping notification job',
          );
          res.status(200).type('html').send(NO_CONVERSATION_HTML);
          return;
        }

        // Enqueue Telegram notification only when conversation row exists
        await queue.add('notify', {
          botId: payload.botId,
          userId: telegramUserId,
          chatId: telegramUserId,
          jti: payload.jti,
        });

        logger.info(
          { botId: payload.botId, jti: payload.jti },
          'verifyEmailRouter: email verified (first time)',
        );
        res.status(200).type('html').send(SUCCESS_HTML);
        return;
      }

      // status === 'verified': already verified — idempotent success, extend expiry via sliding window
      // BLOCKER 2: use extendExpiry (WHERE status='verified') instead of markVerifiedAtomic
      const newExpiresAt = computeNewExpiresAt(tokenRow.expires_at);
      await extendExpiryFn(payload.jti, newExpiresAt);
      await updateToolsetStateFn(payload.botId, telegramUserId, { email: tokenRow.email, email_verified: true });

      logger.debug({ jti: payload.jti }, 'verifyEmailRouter: re-click, extended expiry and refreshed toolset state');
      res.status(200).type('html').send(SUCCESS_HTML);
    } catch (err) {
      logger.error({ err, jti: payload.jti }, 'verifyEmailRouter: unexpected error');
      res.status(500).type('html').send(SERVER_ERROR_HTML);
    }
  });

  return router;
}
