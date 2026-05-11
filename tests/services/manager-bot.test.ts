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
  const BOT_USERNAME = 'animocamind_bot';

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
});
