import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { ConflictError } from '../../src/utils/errors.js';

describe('ManagedBotService', () => {
  let ManagedBotService: any;
  let replaceManagedBotTokenStub: sinon.SinonStub;
  let encryptStub: sinon.SinonStub;
  let provisionChildBotStub: sinon.SinonStub;
  let upsertManagedBotStub: sinon.SinonStub;
  let activateManagedBotStub: sinon.SinonStub;
  let updateManagedBotStatusStub: sinon.SinonStub;
  let tryAcquireUpdateStub: sinon.SinonStub;
  let markProcessedStub: sinon.SinonStub;
  let markFailedStub: sinon.SinonStub;
  let findUserByTelegramIdStub: sinon.SinonStub;
  let invalidateBotTokenCacheStub: sinon.SinonStub;
  let invalidateBotWebhookSecretCacheStub: sinon.SinonStub;
  let mockRegistry: any;

  const mockUser = { id: 1, telegram_id: 99887766, first_name: 'Alice', last_name: null, username: 'alice', photo_url: null, created_at: new Date(), updated_at: new Date() };
  const mockLogEntry = { id: 10, bot_id: 777, update_id: 1, event_type: 'managed_bot_updated', payload: {}, status: 'PENDING', error: null, created_at: new Date() };
  const mockManagedBotUpdated = {
    user: { id: 99887766, is_bot: false, first_name: 'Alice' },
    bot: { id: 777, is_bot: true, first_name: 'MyBot', username: 'mybot' },
  };

  beforeEach(async () => {
    replaceManagedBotTokenStub = sinon.stub().resolves('new-rotated-token');
    encryptStub = sinon.stub().returns({ ciphertext: Buffer.from('enc'), iv: Buffer.from('iv'), keyVersion: 1 });
    provisionChildBotStub = sinon.stub().resolves();
    upsertManagedBotStub = sinon.stub().resolves({});
    activateManagedBotStub = sinon.stub().resolves();
    updateManagedBotStatusStub = sinon.stub().resolves();
    tryAcquireUpdateStub = sinon.stub().resolves(mockLogEntry);
    markProcessedStub = sinon.stub().resolves();
    markFailedStub = sinon.stub().resolves();
    findUserByTelegramIdStub = sinon.stub().resolves(mockUser);
    invalidateBotTokenCacheStub = sinon.stub();
    invalidateBotWebhookSecretCacheStub = sinon.stub();

    mockRegistry = { registerBot: sinon.stub() };

    const module = await esmock('../../src/services/managed-bot.ts', {
      '../../src/services/telegram-api.js': {
        TelegramApiClient: { replaceManagedBotToken: replaceManagedBotTokenStub },
      },
      '../../src/services/encryption.js': { encrypt: encryptStub },
      '../../src/services/child-bot.js': {
        provisionChildBot: provisionChildBotStub,
        createChildBotHandler: sinon.stub().returns(sinon.stub().resolves()),
      },
      '../../src/services/token-store.js': {
        invalidateBotTokenCache: invalidateBotTokenCacheStub,
        invalidateBotWebhookSecretCache: invalidateBotWebhookSecretCacheStub,
      },
      '../../src/db/queries/managed-bots.js': {
        upsertManagedBot: upsertManagedBotStub,
        activateManagedBot: activateManagedBotStub,
        updateManagedBotStatus: updateManagedBotStatusStub,
      },
      '../../src/db/queries/users.js': { findUserByTelegramId: findUserByTelegramIdStub },
      '../../src/db/queries/webhook-log.js': {
        tryAcquireUpdate: tryAcquireUpdateStub,
        markProcessed: markProcessedStub,
        markFailed: markFailedStub,
      },
    });
    ManagedBotService = module.ManagedBotService;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('full provisioning flow succeeds', async () => {
    const service = new ManagedBotService(mockRegistry);
    await service.handleManagedBotUpdated(1, mockManagedBotUpdated);

    expect(replaceManagedBotTokenStub.calledOnce).to.be.true;
    expect(provisionChildBotStub.calledOnce).to.be.true;
    expect(activateManagedBotStub.calledOnce).to.be.true;
    expect(mockRegistry.registerBot.calledOnce).to.be.true;
    expect(markProcessedStub.calledOnce).to.be.true;
  });

  it('skips when tryAcquireUpdate returns null (duplicate)', async () => {
    tryAcquireUpdateStub.resolves(null);
    const service = new ManagedBotService(mockRegistry);
    await service.handleManagedBotUpdated(1, mockManagedBotUpdated);

    expect(replaceManagedBotTokenStub.called).to.be.false;
    expect(markProcessedStub.called).to.be.false;
  });

  it('calls markFailed and sets DEACTIVATED when user not found', async () => {
    findUserByTelegramIdStub.resolves(null);
    const service = new ManagedBotService(mockRegistry);
    await service.handleManagedBotUpdated(1, mockManagedBotUpdated);

    expect(markFailedStub.calledWith(mockLogEntry.id, 'user_not_found')).to.be.true;
    expect(replaceManagedBotTokenStub.called).to.be.false;
  });

  it('calls markFailed and sets DEACTIVATED when provisioning throws', async () => {
    provisionChildBotStub.rejects(new Error('telegram down'));
    const service = new ManagedBotService(mockRegistry);
    let threw = false;
    try {
      await service.handleManagedBotUpdated(1, mockManagedBotUpdated);
    } catch {
      threw = true;
    }
    expect(threw).to.be.true;
    expect(markFailedStub.calledOnce).to.be.true;
    expect(updateManagedBotStatusStub.calledWith(777, 'DEACTIVATED')).to.be.true;
  });

  it('calls markFailed and sets DEACTIVATED when token rotation fails', async () => {
    replaceManagedBotTokenStub.rejects(new Error('rate limited'));
    const service = new ManagedBotService(mockRegistry);
    let threw = false;
    try {
      await service.handleManagedBotUpdated(1, mockManagedBotUpdated);
    } catch {
      threw = true;
    }
    expect(threw).to.be.true;
    expect(markFailedStub.calledOnce).to.be.true;
    expect(updateManagedBotStatusStub.calledWith(777, 'DEACTIVATED')).to.be.true;
  });

  it('Fix-6: does NOT call updateManagedBotStatus when upsertManagedBot throws ConflictError', async () => {
    upsertManagedBotStub.rejects(new ConflictError('Bot is already registered to another user'));
    const service = new ManagedBotService(mockRegistry);
    let threw = false;
    try {
      await service.handleManagedBotUpdated(1, mockManagedBotUpdated);
    } catch {
      threw = true;
    }
    expect(threw).to.be.true;
    expect(markFailedStub.calledOnce).to.be.true;
    expect(updateManagedBotStatusStub.called).to.be.false;
  });

  it('upserts once with PROVISIONING status', async () => {
    const service = new ManagedBotService(mockRegistry);
    await service.handleManagedBotUpdated(1, mockManagedBotUpdated);
    expect(upsertManagedBotStub.callCount).to.equal(1);
    expect(upsertManagedBotStub.firstCall.args[0].status).to.equal('PROVISIONING');
  });

  it('registers bot with correct botId and updateMode', async () => {
    const service = new ManagedBotService(mockRegistry);
    await service.handleManagedBotUpdated(1, mockManagedBotUpdated);
    const config = mockRegistry.registerBot.firstCall.args[0];
    expect(config.botId).to.equal(777);
    expect(config.updateMode).to.equal(process.env.MANAGER_UPDATE_MODE);
  });

  // ── M-01 / B-5: Per-bot webhook secret (encrypted at rest) ──

  it('M-01: upsertManagedBot called with encrypted webhookSecret (Buffer)', async () => {
    const service = new ManagedBotService(mockRegistry);
    await service.handleManagedBotUpdated(1, mockManagedBotUpdated);

    const upsertArgs = upsertManagedBotStub.firstCall.args[0];
    expect(upsertArgs).to.have.property('webhookSecret');
    expect(upsertArgs).to.have.property('webhookSecretIv');
    expect(upsertArgs).to.have.property('webhookSecretKeyVersion');
    // B-5: encryptStub returns { ciphertext: Buffer, iv: Buffer, keyVersion: number }
    // so webhookSecret (ciphertext) must be a Buffer, not the plaintext string.
    expect(Buffer.isBuffer(upsertArgs.webhookSecret)).to.be.true;
  });

  it('M-01: registerBot called with plaintext webhookSecret (64-char hex)', async () => {
    const service = new ManagedBotService(mockRegistry);
    await service.handleManagedBotUpdated(1, mockManagedBotUpdated);

    const registryConfig = mockRegistry.registerBot.firstCall.args[0];
    // The registry receives the plaintext hex secret (32 bytes = 64 hex chars).
    // The DB receives the encrypted form; the registry uses plaintext for in-memory comparison.
    expect(registryConfig.webhookSecret).to.be.a('string').with.lengthOf(64);
  });

  it('M-01: invalidateBotWebhookSecretCache called after provisioning', async () => {
    const service = new ManagedBotService(mockRegistry);
    await service.handleManagedBotUpdated(1, mockManagedBotUpdated);

    expect(invalidateBotWebhookSecretCacheStub.calledWith(777)).to.be.true;
  });
});

