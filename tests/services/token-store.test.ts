import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { pool } from '../../src/db/client.js';
import { encrypt } from '../../src/services/encryption.js';
import { getDecryptedBotToken, invalidateBotTokenCache, tokenCache, CACHE_TTL_MS } from '../../src/services/token-store.js';

// We use the real encryption module to generate a valid DB row so that
// getDecryptedBotToken can decrypt successfully (same approach as managed-bots.test.ts
// which stubs pool directly rather than using esmock).

const PLAINTEXT_TOKEN = 'test-bot-token-abc123';

function makeFakeBotRow() {
  const enc = encrypt(PLAINTEXT_TOKEN);
  return {
    bot_id: 42,
    encrypted_token: enc.ciphertext,
    token_iv: enc.iv,
    token_key_version: enc.keyVersion,
    status: 'ACTIVE',
  };
}

describe('token-store', () => {
  let queryStub: sinon.SinonStub;
  let nowStub: sinon.SinonStub;

  const NOW = 1_000_000;

  beforeEach(() => {
    // Clear the module-level cache before each test so tests are independent
    tokenCache.clear();
    queryStub = sinon.stub(pool, 'query');
    nowStub = sinon.stub(Date, 'now').returns(NOW);
    // Default: pool returns a valid bot row with real encrypted token
    queryStub.resolves({ rows: [makeFakeBotRow()] });
  });

  afterEach(() => sinon.restore());

  it('fetches from DB on first call and returns decrypted token', async () => {
    const token = await getDecryptedBotToken(42);
    expect(token).to.equal(PLAINTEXT_TOKEN);
    expect(queryStub.calledOnce).to.be.true;
  });

  it('cache hit: second call does not query DB', async () => {
    await getDecryptedBotToken(42);
    const callsBefore = queryStub.callCount;

    // Still within TTL — should return cached value without hitting DB
    const token2 = await getDecryptedBotToken(42);
    expect(token2).to.equal(PLAINTEXT_TOKEN);
    expect(queryStub.callCount).to.equal(callsBefore); // no additional DB call
  });

  it('cache expiry: call after TTL hits DB again', async () => {
    await getDecryptedBotToken(42);
    const callsBefore = queryStub.callCount;

    // Advance time past the TTL
    nowStub.returns(NOW + CACHE_TTL_MS + 1);

    await getDecryptedBotToken(42);
    expect(queryStub.callCount).to.equal(callsBefore + 1); // DB queried again
  });

  it('invalidateBotTokenCache causes next call to hit DB', async () => {
    await getDecryptedBotToken(42);
    const callsBefore = queryStub.callCount;

    invalidateBotTokenCache(42);

    await getDecryptedBotToken(42);
    expect(queryStub.callCount).to.equal(callsBefore + 1); // DB queried after invalidation
  });

  it('throws when bot is not found in DB', async () => {
    queryStub.resolves({ rows: [] });
    let error: Error | undefined;
    try {
      await getDecryptedBotToken(99);
    } catch (err) {
      error = err as Error;
    }
    expect(error).to.be.instanceOf(Error);
    expect(error!.message).to.include('99');
  });
});
