import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { insertToken } from '../db/queries/email-verification-tokens.js';

const APP_ISSUER = 'hellominds-telegram-connector';
const EMAIL_VERIFICATION_PURPOSE = 'email-verification';

// BLOCKER 7: strict allowlist regex to guard against email header injection
const SAFE_EMAIL_RE = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

export interface EmailVerificationPayload {
  email: string;
  botId: string;
  userId: string;
  jti: string;
  exp: number;
}

export interface SignedVerificationToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

// ── SESClient singleton ────────────────────────────────────────────────────

let _sesClient: SESClient | null = null;

function getSesClient(): SESClient {
  if (!_sesClient) {
    _sesClient = new SESClient({ region: env.SES_REGION });
  }
  return _sesClient;
}

// ── TTL human-readable helper ──────────────────────────────────────────────

/**
 * Convert a TTL in seconds to a human-readable string.
 * "N minutes" if < 60 min, "N hours" if >= 60 min.
 */
function ttlToHumanReadable(ttlSecs: number): string {
  const minutes = Math.floor(ttlSecs / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

// ── Token sign / verify ────────────────────────────────────────────────────

/**
 * Signs an ES256 JWT for email verification, inserts a pending DB row,
 * and returns { token, jti, expiresAt }.
 * TTL: EMAIL_VERIFICATION_TOKEN_TTL_SECS seconds (default 30 min).
 *
 * @param getNow - Injectable clock for testability (defaults to Date.now)
 */
export async function signVerificationToken(
  email: string,
  botId: string,
  userId: string,
  getNow: () => number = Date.now,
): Promise<SignedVerificationToken> {
  logger.debug({ botId, userId }, 'signVerificationToken: signing');
  try {
    const jti = crypto.randomUUID();
    const ttlSecs = env.EMAIL_VERIFICATION_TOKEN_TTL_SECS;
    const expiresAt = new Date(getNow() + ttlSecs * 1000);

    const payload = {
      email,
      botId,
      userId,
      purpose: EMAIL_VERIFICATION_PURPOSE,
      jti,
    };
    const token = jwt.sign(payload, env.ES256_PRIVATE_KEY, {
      algorithm: 'ES256',
      expiresIn: ttlSecs,
      issuer: APP_ISSUER,
      audience: APP_ISSUER,
    });

    // Persist a pending row in the DB
    await insertToken(jti, email, botId, Number(userId), expiresAt);

    logger.debug({ botId, userId, jti }, 'signVerificationToken: signed and persisted');
    return { token, jti, expiresAt };
  } catch (err) {
    logger.error({ err, botId, userId }, 'signVerificationToken: failed');
    throw err;
  }
}

/**
 * Verifies an ES256 email verification JWT.
 * Throws if the token is invalid, expired, or has the wrong purpose claim.
 */
export function verifyVerificationToken(token: string, getNow: () => number = Date.now): EmailVerificationPayload {
  try {
    const decoded = jwt.verify(token, env.ES256_PUBLIC_KEY, {
      algorithms: ['ES256'],
      issuer: APP_ISSUER,
      audience: APP_ISSUER,
      clockTimestamp: Math.floor(getNow() / 1000),
    }) as jwt.JwtPayload;

    if (decoded.purpose !== EMAIL_VERIFICATION_PURPOSE) {
      logger.warn({ purpose: decoded.purpose }, 'verifyVerificationToken: wrong purpose claim');
      throw new Error('Invalid token purpose');
    }

    if (typeof decoded.email !== 'string' || decoded.email.length === 0) {
      throw new Error('Invalid token email claim');
    }
    if (typeof decoded.botId !== 'string' || decoded.botId.length === 0) {
      throw new Error('Invalid token botId claim');
    }
    if (typeof decoded.userId !== 'string' || decoded.userId.length === 0) {
      throw new Error('Invalid token userId claim');
    }
    if (typeof decoded.jti !== 'string' || decoded.jti.length === 0) {
      throw new Error('Invalid token: missing jti claim');
    }
    if (typeof decoded.exp !== 'number') {
      throw new Error('Invalid token: missing exp claim');
    }

    logger.debug({ botId: decoded.botId, userId: decoded.userId }, 'verifyVerificationToken: valid');
    return {
      email: decoded.email,
      botId: decoded.botId,
      userId: decoded.userId,
      jti: decoded.jti,
      exp: decoded.exp,
    };
  } catch (err) {
    logger.debug({ err }, 'verifyVerificationToken: verification failed');
    throw err;
  }
}

// ── Send verification email ────────────────────────────────────────────────

/**
 * Signs a verification token, inserts a DB row, and sends an SES email
 * containing the verification link.
 *
 * @param getNow - Injectable clock for testability (defaults to Date.now)
 */
export async function sendVerificationEmail(
  email: string,
  botId: string,
  userId: string,
  getNow: () => number = Date.now,
): Promise<void> {
  if (!env.SES_FROM_ADDRESS) {
    throw new Error('SES_FROM_ADDRESS is not configured. Set the SES_FROM_ADDRESS environment variable.');
  }

  // BLOCKER 7: defence-in-depth email header injection guard
  if (!SAFE_EMAIL_RE.test(email)) {
    throw new Error(`sendVerificationEmail: unsafe email address rejected`);
  }

  const { token } = await signVerificationToken(email, botId, userId, getNow);
  const base = new URL('/verify-email', env.BASE_URL);
  base.searchParams.set('token', token);
  const verifyUrl = base.toString();
  const fromAddress = env.SES_FROM_ADDRESS;

  // BLOCKER 1: derive human-readable TTL from env instead of hardcoding "30 minutes"
  const ttlLabel = ttlToHumanReadable(env.EMAIL_VERIFICATION_TOKEN_TTL_SECS);

  logger.info({ botId, userId }, 'sendVerificationEmail: sending');

  const textBody = `Please verify your email address by visiting the following link:\n\n${verifyUrl}\n\nThis link will expire in ${ttlLabel}.\n\nIf you did not request this verification, you can safely ignore this email.`;

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Verify your email</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f9fafb; margin: 0; padding: 2rem; }
  .card { background: #fff; border-radius: 12px; padding: 2.5rem; max-width: 480px; margin: 0 auto; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { color: #111827; font-size: 1.5rem; margin-bottom: 0.5rem; }
  p { color: #6b7280; line-height: 1.6; }
  .btn { display: inline-block; margin-top: 1.5rem; padding: 0.75rem 1.5rem; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; }
  .footer { margin-top: 2rem; font-size: 0.875rem; color: #9ca3af; }
</style></head>
<body>
<div class="card">
  <h1>Verify your email</h1>
  <p>Click the button below to verify your email address and unlock your tools.</p>
  <a class="btn" href="${verifyUrl}">Verify email</a>
  <p class="footer">This link will expire in ${ttlLabel}. If you did not request this, you can safely ignore this email.</p>
</div>
</body>
</html>`;

  const command = new SendEmailCommand({
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: 'Verify your email', Charset: 'UTF-8' },
      Body: {
        Text: { Data: textBody, Charset: 'UTF-8' },
        Html: { Data: htmlBody, Charset: 'UTF-8' },
      },
    },
    Source: fromAddress,
  });

  try {
    await getSesClient().send(command);
    logger.info({ botId, userId }, 'sendVerificationEmail: sent successfully');
  } catch (err) {
    logger.error({ err, botId, userId }, 'sendVerificationEmail: SES send failed');
    throw err;
  }
}
