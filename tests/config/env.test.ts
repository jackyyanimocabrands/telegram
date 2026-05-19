/**
 * Unit tests for the envSchema boolean transform in env.ts.
 *
 * We import envSchema directly (it is now a named export).
 * The module-level safeParse(process.env) still runs when the module loads, but
 * since the test environment has a valid .env, this is fine. We call
 * envSchema.safeParse({ ...minimalEnv, ... }) independently to exercise transforms.
 */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import esmock from 'esmock';

// ---------------------------------------------------------------------------
// Load envSchema in isolation — esmock prevents the dotenv side-effect from
// mutating process.env and gives us a fresh module instance per test file.
// ---------------------------------------------------------------------------

async function loadEnvSchema() {
  const mod = await esmock('../../src/config/env.js', {
    'dotenv': { config: () => {} }, // no-op — prevents dotenv from overriding test env
  });
  return mod.envSchema as import('../../src/config/env.js')['envSchema'];
}

// ---------------------------------------------------------------------------
// A minimal valid env object that satisfies all required fields.
// Tests override individual fields on top of this.
// ---------------------------------------------------------------------------

const MINIMAL_ENV: Record<string, unknown> = {
  NODE_ENV: 'test',
  BOT_TOKEN: 'fake_bot_token_1234567890',
  BOT_USERNAME: 'fake_bot',
  WEBHOOK_SECRET: 'a'.repeat(32),
  DATABASE_URL: 'postgresql://localhost:5432/test',
  ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
  ES256_PRIVATE_KEY: '-----BEGIN EC PRIVATE KEY-----\nfake\n-----END EC PRIVATE KEY-----',
  ES256_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
  BASE_URL: 'https://example.com',
  ADMIN_API_KEY: 'a'.repeat(32),
};

// ===========================================================================
// Tests
// ===========================================================================

describe('envSchema boolean transforms (EPHEMERAL_CONTEXT_* flags)', () => {
  it('maps string "false" to false for EPHEMERAL_CONTEXT_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_ENABLED: 'false' });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_ENABLED).to.be.false;
  });

  it('maps string "false" to false for EPHEMERAL_CONTEXT_DATETIME_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_DATETIME_ENABLED: 'false' });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_DATETIME_ENABLED).to.be.false;
  });

  it('maps string "false" to false for EPHEMERAL_CONTEXT_LOCALE_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_LOCALE_ENABLED: 'false' });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_LOCALE_ENABLED).to.be.false;
  });

  it('maps string "1" to true for EPHEMERAL_CONTEXT_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_ENABLED: '1' });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_ENABLED).to.be.true;
  });

  it('maps string "true" to true for EPHEMERAL_CONTEXT_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_ENABLED: 'true' });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_ENABLED).to.be.true;
  });

  it('maps string "TRUE" (uppercase) to true for EPHEMERAL_CONTEXT_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_ENABLED: 'TRUE' });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_ENABLED).to.be.true;
  });

  it('maps string "True" (mixed case) to true for EPHEMERAL_CONTEXT_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_ENABLED: 'True' });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_ENABLED).to.be.true;
  });

  it('maps string "0" to false for EPHEMERAL_CONTEXT_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_ENABLED: '0' });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_ENABLED).to.be.false;
  });

  it('defaults EPHEMERAL_CONTEXT_ENABLED to true when omitted', async () => {
    const envSchema = await loadEnvSchema();
    const { EPHEMERAL_CONTEXT_ENABLED: _, ...envWithout } = MINIMAL_ENV as any;
    const result = envSchema.safeParse(envWithout);
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_ENABLED).to.be.true;
  });

  it('maps boolean true to true for EPHEMERAL_CONTEXT_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_ENABLED: true });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_ENABLED).to.be.true;
  });

  it('maps boolean false to false for EPHEMERAL_CONTEXT_ENABLED', async () => {
    const envSchema = await loadEnvSchema();
    const result = envSchema.safeParse({ ...MINIMAL_ENV, EPHEMERAL_CONTEXT_ENABLED: false });
    expect(result.success).to.be.true;
    expect((result as any).data.EPHEMERAL_CONTEXT_ENABLED).to.be.false;
  });
});
