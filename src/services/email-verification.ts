import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const APP_ISSUER = 'hellominds-telegram-connector';
const EMAIL_VERIFICATION_PURPOSE = 'email-verification';

export interface EmailVerificationPayload {
  email: string;
  botId: string;
  userId: string;
  jti: string;
  exp: number;
}

// ── SESClient singleton ────────────────────────────────────────────────────

let _sesClient: SESClient | null = null;

function getSesClient(): SESClient {
  if (!_sesClient) {
    _sesClient = new SESClient({ region: env.SES_REGION });
  }
  return _sesClient;
}

// ── Token sign / verify ────────────────────────────────────────────────────

/**
 * Signs an ES256 JWT for email verification.
 * Payload: { email, botId, userId, purpose: 'email-verification' }
 * TTL: EMAIL_VERIFICATION_TOKEN_TTL_SECS seconds (default 24h).
 */
export function signVerificationToken(email: string, botId: string, userId: string): string {
  logger.debug({ email, botId, userId }, 'signVerificationToken: signing');
  try {
    const payload = {
      email,
      botId,
      userId,
      purpose: EMAIL_VERIFICATION_PURPOSE,
      jti: crypto.randomUUID(),
    };
    const token = jwt.sign(payload, env.ES256_PRIVATE_KEY, {
      algorithm: 'ES256',
      expiresIn: env.EMAIL_VERIFICATION_TOKEN_TTL_SECS,
      issuer: APP_ISSUER,
      audience: APP_ISSUER,
    });
    logger.debug({ email, botId, userId }, 'signVerificationToken: signed successfully');
    return token;
  } catch (err) {
    logger.error({ err, email, botId, userId }, 'signVerificationToken: failed to sign token');
    throw err;
  }
}

/**
 * Verifies an ES256 email verification JWT.
 * Throws if the token is invalid, expired, or has the wrong purpose claim.
 */
export function verifyVerificationToken(token: string): EmailVerificationPayload {
  try {
    const decoded = jwt.verify(token, env.ES256_PUBLIC_KEY, {
      algorithms: ['ES256'],
      issuer: APP_ISSUER,
      audience: APP_ISSUER,
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

    logger.debug({ email: decoded.email, botId: decoded.botId, userId: decoded.userId }, 'verifyVerificationToken: valid');
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
 * Signs a verification token and sends an SES email containing the verification link.
 */
export async function sendVerificationEmail(email: string, botId: string, userId: string): Promise<void> {
  if (!env.SES_FROM_ADDRESS) {
    throw new Error('SES_FROM_ADDRESS is not configured. Set the SES_FROM_ADDRESS environment variable.');
  }
  const token = signVerificationToken(email, botId, userId);
  const verifyUrl = `${env.BASE_URL}/verify-email?token=${token}`;
  const fromAddress = env.SES_FROM_ADDRESS;

  logger.info({ email, botId, userId }, 'sendVerificationEmail: sending');

  const textBody = `Please verify your email address by visiting the following link:\n\n${verifyUrl}\n\nThis link will expire in 24 hours.\n\nIf you did not request this verification, you can safely ignore this email.`;

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
  <p class="footer">This link will expire in 24 hours. If you did not request this, you can safely ignore this email.</p>
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
    logger.info({ email, botId, userId }, 'sendVerificationEmail: sent successfully');
  } catch (err) {
    logger.error({ err, email, botId, userId }, 'sendVerificationEmail: SES send failed');
    throw err;
  }
}
