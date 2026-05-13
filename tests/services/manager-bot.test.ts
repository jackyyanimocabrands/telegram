import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { MockTelegramClient } from '../mocks/telegram-client.js';

describe('handleManagerBotMessage', () => {
  let handleManagerBotMessage: any;
  let mockTelegram: MockTelegramClient;
  let agentServiceStub: {
    chat: sinon.SinonStub;
    clearContext: sinon.SinonStub;
    switchProvider: sinon.SinonStub;
    generateWarmPrompt: sinon.SinonStub;
  };
  let findManagedBotByOwnerStub: sinon.SinonStub;

  const MANAGER_TOKEN = 'manager-token-abc';
  const MANAGER_BOT_ID = 'manager';
  const BASE_URL = 'https://example.com';
  const BOT_USERNAME = 'hellominds_bot';

  const makeMessage = (overrides: Partial<{
    chatId: number;
    fromId: number;
    fromFirstName: string;
    fromUsername: string;
    text: string;
    from: any;
  }> = {}) => ({
    message_id: 1,
    chat: { id: overrides.chatId ?? 100, type: 'private' as const },
    date: 1,
    from: overrides.from !== undefined ? overrides.from : {
      id: overrides.fromId ?? 42,
      is_bot: false,
      first_name: overrides.fromFirstName ?? 'Alice',
      username: overrides.fromUsername ?? 'alice',
    },
    text: overrides.text ?? 'hello',
  });

  beforeEach(async () => {
    mockTelegram = new MockTelegramClient();
    mockTelegram.sendMessage.resolves({ message_id: 99, chat: { id: 100 }, date: 1 });

    agentServiceStub = {
      chat: sinon.stub().resolves('AI reply'),
      clearContext: sinon.stub().resolves(),
      switchProvider: sinon.stub().resolves(),
      generateWarmPrompt: sinon.stub().resolves(null),
    };

    findManagedBotByOwnerStub = sinon.stub().resolves(null);

    const module = await esmock('../../src/services/manager-bot.ts', {
      '../../src/db/queries/managed-bots.js': {
        findManagedBotByOwner: findManagedBotByOwnerStub,
      },
    });
    handleManagerBotMessage = module.handleManagerBotMessage;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('ignores message when from is missing', async () => {
    // Build message without a `from` field (simulating anonymous channel post)
    const message = {
      message_id: 1,
      chat: { id: 100, type: 'private' as const },
      date: 1,
      text: 'hello',
    };
    await handleManagerBotMessage(message as any, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);
    expect(agentServiceStub.chat.called).to.be.false;
    expect(mockTelegram.sendMessage.called).to.be.false;
  });

  it('routes to onboarding prompt when user has no bot (null)', async () => {
    findManagedBotByOwnerStub.resolves(null);
    const message = makeMessage({ fromFirstName: 'Alice' });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(agentServiceStub.chat.calledOnce).to.be.true;
    const systemPrompt: string = agentServiceStub.chat.firstCall.args[3];
    expect(systemPrompt).to.include('onboarding');
    expect(systemPrompt).to.include('https://t.me/newbot');
  });

  it('routes to onboarding prompt when bot status is PENDING', async () => {
    findManagedBotByOwnerStub.resolves({ status: 'PENDING', bot_username: 'alicebot' });
    const message = makeMessage({ fromFirstName: 'Alice' });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(agentServiceStub.chat.calledOnce).to.be.true;
    const systemPrompt: string = agentServiceStub.chat.firstCall.args[3];
    expect(systemPrompt).to.include('onboarding');
    expect(systemPrompt).to.include('currently being set up');
  });

  it('routes to onboarding prompt when bot status is PROVISIONING', async () => {
    findManagedBotByOwnerStub.resolves({ status: 'PROVISIONING', bot_username: 'alicebot' });
    const message = makeMessage();

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    const systemPrompt: string = agentServiceStub.chat.firstCall.args[3];
    expect(systemPrompt).to.include('currently being set up');
  });

  it('routes to settings/billing prompt when bot status is ACTIVE', async () => {
    findManagedBotByOwnerStub.resolves({ status: 'ACTIVE', bot_username: 'alicebot' });
    const message = makeMessage({ fromFirstName: 'Alice' });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(agentServiceStub.chat.calledOnce).to.be.true;
    const systemPrompt: string = agentServiceStub.chat.firstCall.args[3];
    expect(systemPrompt).to.include('settings');
    expect(systemPrompt).to.include('@alicebot');
    expect(systemPrompt).not.to.include('onboarding');
  });

  it('sends LLM reply to user via telegram.sendMessage', async () => {
    agentServiceStub.chat.resolves('Here is my helpful response');
    const message = makeMessage({ chatId: 999 });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(mockTelegram.sendMessage.calledOnce).to.be.true;
    expect(mockTelegram.sendMessage.firstCall.args[0]).to.equal(MANAGER_TOKEN);
    expect(mockTelegram.sendMessage.firstCall.args[1]).to.equal(999);
    expect(mockTelegram.sendMessage.firstCall.args[2]).to.equal('Here is my helpful response');
  });

  it('sends error fallback message when agentService.chat throws', async () => {
    agentServiceStub.chat.rejects(new Error('LLM down'));
    const message = makeMessage({ chatId: 555 });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(mockTelegram.sendMessage.calledOnce).to.be.true;
    const fallback: string = mockTelegram.sendMessage.firstCall.args[2];
    expect(fallback).to.include('Sorry');
    expect(fallback).to.include('try again');
  });

  it('passes correct botId and userId to agentService.chat', async () => {
    const message = makeMessage({ fromId: 77, text: 'test message' });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(agentServiceStub.chat.firstCall.args[0]).to.equal('manager');
    expect(agentServiceStub.chat.firstCall.args[1]).to.equal(77);
    expect(agentServiceStub.chat.firstCall.args[2]).to.equal('test message');
  });

  describe('env prompt overrides', () => {
    let handleManagerBotMessageWithEnv: any;
    let findManagedBotByOwnerEnvStub: sinon.SinonStub;
    let agentEnvStub: { chat: sinon.SinonStub };
    let mockTelegramEnv: MockTelegramClient;

    beforeEach(async () => {
      mockTelegramEnv = new MockTelegramClient();
      mockTelegramEnv.sendMessage.resolves({ message_id: 99, chat: { id: 100 }, date: 1 });
      agentEnvStub = { chat: sinon.stub().resolves('reply') };
      findManagedBotByOwnerEnvStub = sinon.stub();
    });

    afterEach(async () => {
      sinon.restore();
      await esmock.purge();
    });

    it('uses MANAGER_ONBOARDING_PROMPT template and interpolates {deepLink}', async () => {
      findManagedBotByOwnerEnvStub.resolves(null);

      const mod = await esmock('../../src/services/manager-bot.ts', {
        '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: findManagedBotByOwnerEnvStub },
        '../../src/config/env.js': {
          env: { MANAGER_ONBOARDING_PROMPT: 'Custom onboarding. Link: {deepLink}' },
        },
        '../../src/utils/interpolate.js': { interpolate: (t: string, v: Record<string, string>) => t.replace(/\{([^}]+)\}/g, (m: string, k: string) => v[k] ?? m) },
      });

      const msg = {
        message_id: 1,
        chat: { id: 100, type: 'private' as const },
        date: 1,
        from: { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: 'hi',
      };

      await mod.handleManagerBotMessage(msg, mockTelegramEnv, agentEnvStub, 'token', 'manager', 'https://x.com', 'mybot');

      const systemPrompt: string = agentEnvStub.chat.firstCall.args[3];
      expect(systemPrompt).to.include('Custom onboarding');
      expect(systemPrompt).to.include('https://t.me/newbot');
      expect(systemPrompt).not.to.include('{deepLink}');
    });

    it('uses MANAGER_SETTINGS_PROMPT template and interpolates {name} and {botUsername}', async () => {
      findManagedBotByOwnerEnvStub.resolves({ status: 'ACTIVE', bot_username: 'alicebot' });

      const mod = await esmock('../../src/services/manager-bot.ts', {
        '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: findManagedBotByOwnerEnvStub },
        '../../src/config/env.js': {
          env: { MANAGER_SETTINGS_PROMPT: 'Welcome {name}. Your bot is @{botUsername}.' },
        },
        '../../src/utils/interpolate.js': { interpolate: (t: string, v: Record<string, string>) => t.replace(/\{([^}]+)\}/g, (m: string, k: string) => v[k] ?? m) },
      });

      const msg = {
        message_id: 1,
        chat: { id: 100, type: 'private' as const },
        date: 1,
        from: { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: 'hi',
      };

      await mod.handleManagerBotMessage(msg, mockTelegramEnv, agentEnvStub, 'token', 'manager', 'https://x.com', 'mybot');

      const systemPrompt: string = agentEnvStub.chat.firstCall.args[3];
      expect(systemPrompt).to.equal('Welcome Alice. Your bot is @alicebot.');
    });

    it('falls back to default onboarding prompt when MANAGER_ONBOARDING_PROMPT is absent', async () => {
      findManagedBotByOwnerEnvStub.resolves(null);

      const mod = await esmock('../../src/services/manager-bot.ts', {
        '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: findManagedBotByOwnerEnvStub },
        '../../src/config/env.js': { env: {} },
        '../../src/utils/interpolate.js': { interpolate: (t: string, v: Record<string, string>) => t.replace(/\{([^}]+)\}/g, (m: string, k: string) => v[k] ?? m) },
      });

      const msg = {
        message_id: 1,
        chat: { id: 100, type: 'private' as const },
        date: 1,
        from: { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: 'hi',
      };

      await mod.handleManagerBotMessage(msg, mockTelegramEnv, agentEnvStub, 'token', 'manager', 'https://x.com', 'mybot');

      const systemPrompt: string = agentEnvStub.chat.firstCall.args[3];
      expect(systemPrompt).to.include('onboarding assistant for HelloMinds');
      expect(systemPrompt).to.include('https://t.me/newbot');
    });
  });
});
