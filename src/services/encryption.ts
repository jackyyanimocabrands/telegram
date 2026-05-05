import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
// Named domain-separation salt — purpose is domain separation, not uniqueness.
// ENCRYPTION_KEY_VERSION provides per-key versioning on top of this.
const HKDF_SALT = Buffer.from('animocamind-telegram-connector-v1', 'utf8');

/**
 * Derive a per-version AES-256 key using HKDF.
 * Different keyVersion values produce completely different 32-byte keys.
 */
function deriveKey(keyVersion: number): Buffer {
  const masterKey = Buffer.from(env.ENCRYPTION_MASTER_KEY, 'hex');
  if (masterKey.length !== 32) {
    logger.error({ keyVersion, masterKeyLength: masterKey.length }, 'deriveKey: invalid ENCRYPTION_MASTER_KEY length, must be 32 bytes');
    throw new Error(`ENCRYPTION_MASTER_KEY must be 32 bytes, got ${masterKey.length}`);
  }

  const info = Buffer.from(`animocamind-v${keyVersion}`);
  const derived = crypto.hkdfSync('sha256', masterKey, HKDF_SALT, info, 32);
  return Buffer.from(derived);
}

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  keyVersion: number;
}

export function encrypt(plaintext: string): EncryptedPayload {
  const keyVersion = env.ENCRYPTION_KEY_VERSION;
  logger.debug({ keyVersion }, 'encrypt: encrypting payload');
  const key = deriveKey(keyVersion);
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();
  const ciphertextWithTag = Buffer.concat([authTag, encrypted]);

  logger.debug({ keyVersion }, 'encrypt: done');
  return {
    ciphertext: ciphertextWithTag,
    iv,
    keyVersion,
  };
}

export function decrypt(ciphertext: Buffer, iv: Buffer, keyVersion: number): string {
  logger.debug({ keyVersion }, 'decrypt: decrypting payload');
  const key = deriveKey(keyVersion);

  const authTag = ciphertext.subarray(0, AUTH_TAG_BYTES);
  const encrypted = ciphertext.subarray(AUTH_TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    logger.debug({ keyVersion }, 'decrypt: done');
    return decrypted.toString('utf8');
  } catch (err) {
    logger.error({ err, keyVersion }, 'decrypt: failed — possible data tampering or wrong key');
    throw err;
  }
}
