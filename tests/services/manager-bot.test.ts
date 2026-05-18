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
    chatStream: sinon.SinonStub;
    clearContext: sinon.SinonStub;
    generateWarmPrompt: sinon.SinonStub;
  };
  let findManagedBotByOwnerStub: sinon.SinonStub;
  let checkThrottleStub: sinon.SinonStub;
  let acquireLockStub: sinon.SinonStub;
  let releaseLockStub: sinon.SinonStub;
  let queueAddStub: sinon.SinonStub;

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

    async function* defaultStream() { yield 'AI reply'; }
    agentServiceStub = {
      chat: sinon.stub().resolves('AI reply'),
      chatStream: sinon.stub().returns(defaultStream()),
      clearContext: sinon.stub().resolves(),
      generateWarmPrompt: sinon.stub().resolves(null),
    };

    findManagedBotByOwnerStub = sinon.stub().resolves(null);
    checkThrottleStub = sinon.stub().resolves({ allowed: true, retryAfterMs: 0 });
    acquireLockStub = sinon.stub().resolves(true);
    releaseLockStub = sinon.stub().resolves();
    queueAddStub = sinon.stub().resolves({ id: 'test-job-1' });

    const module = await esmock('../../src/services/manager-bot.ts', {
      '../../src/db/queries/managed-bots.js': {
        findManagedBotByOwner: findManagedBotByOwnerStub,
      },
      '../../src/db/queries/conversations.js': {
        getToolsetState: sinon.stub().resolves({}),
      },
      '../../src/services/tool-tier.js': {
        resolveToolTier: sinon.stub().returns('base'),
        getToolsForTier: sinon.stub().returns([]),
      },
      '../../src/services/conversation-throttle.js': {
        checkThrottle: checkThrottleStub,
      },
      '../../src/services/conversation-lock.js': {
        acquireLock: acquireLockStub,
        releaseLock: releaseLockStub,
      },
      '../../src/queues/manager-queue.js': {
        managerQueue: { add: queueAddStub },
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

    expect(agentServiceStub.chatStream.calledOnce).to.be.true;
    const systemPrompt: string = agentServiceStub.chatStream.firstCall.args[3];
    expect(systemPrompt).to.include('general assistant');
    expect(systemPrompt).to.include('https://t.me/newbot');
  });

  it('routes to onboarding prompt when bot status is PENDING', async () => {
    findManagedBotByOwnerStub.resolves({ status: 'PENDING', bot_username: 'alicebot' });
    const message = makeMessage({ fromFirstName: 'Alice' });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(agentServiceStub.chatStream.calledOnce).to.be.true;
    const systemPrompt: string = agentServiceStub.chatStream.firstCall.args[3];
    expect(systemPrompt).to.include('general assistant');
    expect(systemPrompt).to.include('currently being set up');
  });

  it('routes to onboarding prompt when bot status is PROVISIONING', async () => {
    findManagedBotByOwnerStub.resolves({ status: 'PROVISIONING', bot_username: 'alicebot' });
    const message = makeMessage();

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    const systemPrompt: string = agentServiceStub.chatStream.firstCall.args[3];
    expect(systemPrompt).to.include('currently being set up');
  });

  it('routes to settings/billing prompt when bot status is ACTIVE', async () => {
    findManagedBotByOwnerStub.resolves({ status: 'ACTIVE', bot_username: 'alicebot' });
    const message = makeMessage({ fromFirstName: 'Alice' });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(agentServiceStub.chatStream.calledOnce).to.be.true;
    const systemPrompt: string = agentServiceStub.chatStream.firstCall.args[3];
    expect(systemPrompt).to.include('account creation');
    expect(systemPrompt).to.include('@alicebot');
    expect(systemPrompt).not.to.include('onboarding');
  });

  it('sends LLM reply to user via telegram.sendMessage', async () => {
    async function* stream() { yield 'Here is my helpful response'; }
    agentServiceStub.chatStream.returns(stream());
    const message = makeMessage({ chatId: 999 });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(mockTelegram.sendMessage.calledOnce).to.be.true;
    expect(mockTelegram.sendMessage.firstCall.args[0]).to.equal(MANAGER_TOKEN);
    expect(mockTelegram.sendMessage.firstCall.args[1]).to.equal(999);
    expect(mockTelegram.sendMessage.firstCall.args[2]).to.equal('Here is my helpful response');
  });

  it('sends error fallback message when agentService.chat throws', async () => {
    async function* throwingStream(): AsyncGenerator<string> { throw new Error('LLM down'); yield ''; }
    agentServiceStub.chatStream.returns(throwingStream());
    const message = makeMessage({ chatId: 555 });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(mockTelegram.sendMessage.calledOnce).to.be.true;
    const fallback: string = mockTelegram.sendMessage.firstCall.args[2];
    expect(fallback).to.include('Sorry');
    expect(fallback).to.include('try again');
  });

  it('passes correct botId and userId to agentService.chatStream', async () => {
    const message = makeMessage({ fromId: 77, text: 'test message' });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(agentServiceStub.chatStream.firstCall.args[0]).to.equal('manager');
    expect(agentServiceStub.chatStream.firstCall.args[1]).to.equal(77);
    expect(agentServiceStub.chatStream.firstCall.args[2]).to.equal('test message');
  });

  it('sends thinking bubble after 250ms delay before stream starts', async () => {
    const message = makeMessage({ chatId: 100 });
    const clock = sinon.useFakeTimers();
    try {
      const promise = handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);
      await clock.tickAsync(300); // advance past 250ms
      await promise;
      expect(mockTelegram.sendMessageDraft.calledWith(MANAGER_TOKEN, 100, sinon.match.number, 'Thinking')).to.be.true;
    } finally {
      clock.restore();
    }
  });

  it('sendChatAction typing is called when first token arrives', async () => {
    const message = makeMessage({ chatId: 100 });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(mockTelegram.sendChatAction.calledWith(MANAGER_TOKEN, 100, 'typing')).to.be.true;
  });

  it('sendMessageDraft is called with MarkdownV2 content during stream (fire-and-forget)', async () => {
    async function* stream() { yield 'Hello world. '; yield 'chunk2'; yield 'chunk3'; }
    agentServiceStub.chatStream.returns(stream());
    const message = makeMessage({ chatId: 100 });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    // At least one draft call with MarkdownV2 content (fire-and-forget during stream)
    const mdCalls = mockTelegram.sendMessageDraft.args.filter((args: unknown[]) => args[4] === 'MarkdownV2');
    expect(mdCalls.length).to.be.greaterThan(0);
  });

  it('sendMessageDraft during stream shows only complete sentences', async () => {
    async function* stream() {
      yield 'Hello world';
      yield '. ';
      yield 'Partial chunk';
    }
    agentServiceStub.chatStream.returns(stream());
    const message = makeMessage({ chatId: 100 });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    const mdCalls = mockTelegram.sendMessageDraft.args.filter((args: unknown[]) => args[4] === 'MarkdownV2');
    // Draft sends accumulated content as-is (no sentence trimming)
    expect(mdCalls.length).to.be.greaterThan(0);
    // Final draft content should include the full accumulated text
    const lastCall = mdCalls[mdCalls.length - 1];
    const content: string = lastCall[3];
    expect(content).to.include('Hello world');
  });

  it('sendChatAction is refreshed after TYPING_REFRESH_MS during a long stream', async () => {
    const TYPING_REFRESH_MS = 4000;
    let nowValue = TYPING_REFRESH_MS + 1; // start above threshold so first chunk fires immediately
    const dateNowStub = sinon.stub(Date, 'now').callsFake(() => nowValue);

    async function* longStream() {
      yield 'first';                          // now = 4001 → triggers first typing call (4001 - 0 >= 4000)
      nowValue += TYPING_REFRESH_MS + 1;      // advance past refresh threshold
      yield 'second';                         // now = 8002 → should trigger second typing call
    }
    agentServiceStub.chatStream.returns(longStream());
    const message = makeMessage({ chatId: 100 });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    dateNowStub.restore();

    // sendChatAction should be called twice: once on first token, once after refresh
    expect(mockTelegram.sendChatAction.callCount).to.equal(2);
    expect(mockTelegram.sendChatAction.alwaysCalledWith(MANAGER_TOKEN, 100, 'typing')).to.be.true;
  });

  it('sendMessageDraft failure does not prevent final sendMessage', async () => {
    mockTelegram.sendMessageDraft.rejects(new Error('draft API unavailable'));
    async function* stream() { yield 'safe manager reply'; }
    agentServiceStub.chatStream.returns(stream());
    const message = makeMessage({ chatId: 100 });

    await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(mockTelegram.sendMessage.called).to.be.true;
    const text: string = mockTelegram.sendMessage.firstCall.args[2];
    expect(text).to.include('safe manager reply');
  });

  describe('conversation throttle', () => {
    it('replies with wait seconds and skips chatStream when throttled', async () => {
      const throttledStub = sinon.stub().resolves({ allowed: false, retryAfterMs: 3500 });
      const mod = await esmock('../../src/services/manager-bot.ts', {
        '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: findManagedBotByOwnerStub },
        '../../src/services/conversation-throttle.js': { checkThrottle: throttledStub },
        '../../src/services/conversation-lock.js': { acquireLock: acquireLockStub, releaseLock: releaseLockStub },
        '../../src/queues/manager-queue.js': { managerQueue: { add: queueAddStub } },
      });
      const message = makeMessage({ chatId: 100, fromId: 42 });

      await mod.handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

      expect(agentServiceStub.chatStream.called).to.be.false;
      expect(mockTelegram.sendMessage.calledOnce).to.be.true;
      const replyText: string = mockTelegram.sendMessage.firstCall.args[2];
      // Math.ceil(3500 / 1000) = 4
      expect(replyText).to.include('4');
      expect(replyText).to.include('second');
    });

    it('proceeds normally when throttle allows the message', async () => {
      const message = makeMessage({ fromId: 77, text: 'hello' });

      await handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

      expect(agentServiceStub.chatStream.calledOnce).to.be.true;
      expect(checkThrottleStub.calledOnce).to.be.true;
      // conversationId is 'manager:77'
      expect(checkThrottleStub.firstCall.args[0]).to.equal('manager:77');
    });

    it('proceeds normally when throttle check throws (fail-open)', async () => {
      const errorStub = sinon.stub().rejects(new Error('Redis down'));
      const mod = await esmock('../../src/services/manager-bot.ts', {
        '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: findManagedBotByOwnerStub },
        '../../src/services/conversation-throttle.js': { checkThrottle: errorStub },
        '../../src/services/conversation-lock.js': { acquireLock: acquireLockStub, releaseLock: releaseLockStub },
        '../../src/queues/manager-queue.js': { managerQueue: { add: queueAddStub } },
      });
      const message = makeMessage({ chatId: 100, fromId: 42 });

      await mod.handleManagerBotMessage(message, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

      // Fail-open: chatStream still called despite Redis error
      expect(agentServiceStub.chatStream.calledOnce).to.be.true;
    });
  });

  describe('env prompt overrides', () => {
    let handleManagerBotMessageWithEnv: any;
    let findManagedBotByOwnerEnvStub: sinon.SinonStub;
    let agentEnvStub: { chat: sinon.SinonStub; chatStream: sinon.SinonStub };
    let mockTelegramEnv: MockTelegramClient;

    beforeEach(async () => {
      mockTelegramEnv = new MockTelegramClient();
      mockTelegramEnv.sendMessage.resolves({ message_id: 99, chat: { id: 100 }, date: 1 });
      async function* defaultStream() { yield 'reply'; }
      agentEnvStub = { chat: sinon.stub().resolves('reply'), chatStream: sinon.stub().returns(defaultStream()) };
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
        '../../src/services/conversation-throttle.js': { checkThrottle: sinon.stub().resolves({ allowed: true, retryAfterMs: 0 }) },
        '../../src/services/conversation-lock.js': { acquireLock: sinon.stub().resolves(true), releaseLock: sinon.stub().resolves() },
        '../../src/queues/manager-queue.js': { managerQueue: { add: sinon.stub().resolves({ id: 'j1' }) } },
      });

      const msg = {
        message_id: 1,
        chat: { id: 100, type: 'private' as const },
        date: 1,
        from: { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: 'hi',
      };

      await mod.handleManagerBotMessage(msg, mockTelegramEnv, agentEnvStub, 'token', 'manager', 'https://x.com', 'mybot');

      const systemPrompt: string = agentEnvStub.chatStream.firstCall.args[3];
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
        '../../src/services/conversation-throttle.js': { checkThrottle: sinon.stub().resolves({ allowed: true, retryAfterMs: 0 }) },
        '../../src/services/conversation-lock.js': { acquireLock: sinon.stub().resolves(true), releaseLock: sinon.stub().resolves() },
        '../../src/queues/manager-queue.js': { managerQueue: { add: sinon.stub().resolves({ id: 'j1' }) } },
      });

      const msg = {
        message_id: 1,
        chat: { id: 100, type: 'private' as const },
        date: 1,
        from: { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: 'hi',
      };

      await mod.handleManagerBotMessage(msg, mockTelegramEnv, agentEnvStub, 'token', 'manager', 'https://x.com', 'mybot');

      const systemPrompt: string = agentEnvStub.chatStream.firstCall.args[3];
      expect(systemPrompt).to.equal('Welcome Alice. Your bot is @alicebot.');
    });

    it('falls back to default onboarding prompt when MANAGER_ONBOARDING_PROMPT is absent', async () => {
      findManagedBotByOwnerEnvStub.resolves(null);

      const mod = await esmock('../../src/services/manager-bot.ts', {
        '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: findManagedBotByOwnerEnvStub },
        '../../src/config/env.js': { env: {} },
        '../../src/utils/interpolate.js': { interpolate: (t: string, v: Record<string, string>) => t.replace(/\{([^}]+)\}/g, (m: string, k: string) => v[k] ?? m) },
        '../../src/services/conversation-throttle.js': { checkThrottle: sinon.stub().resolves({ allowed: true, retryAfterMs: 0 }) },
        '../../src/services/conversation-lock.js': { acquireLock: sinon.stub().resolves(true), releaseLock: sinon.stub().resolves() },
        '../../src/queues/manager-queue.js': { managerQueue: { add: sinon.stub().resolves({ id: 'j1' }) } },
      });

      const msg = {
        message_id: 1,
        chat: { id: 100, type: 'private' as const },
        date: 1,
        from: { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' },
        text: 'hi',
      };

      await mod.handleManagerBotMessage(msg, mockTelegramEnv, agentEnvStub, 'token', 'manager', 'https://x.com', 'mybot');

      const systemPrompt: string = agentEnvStub.chatStream.firstCall.args[3];
      expect(systemPrompt).to.include('general assistant for HelloMinds');
      expect(systemPrompt).to.include('https://t.me/newbot');
    });
  });
});

describe('enqueueManagerMessage', () => {
  let enqueueManagerMessage: any;
  let mockTelegram: MockTelegramClient;
  let acquireLockStub: sinon.SinonStub;
  let releaseLockStub: sinon.SinonStub;
  let checkThrottleStub: sinon.SinonStub;
  let queueAddStub: sinon.SinonStub;

  const MANAGER_TOKEN = 'manager-token-abc';
  const BOT_USERNAME = 'hellominds_bot';

  const makeMessage = (overrides: Partial<{ chatId: number; fromId: number; messageId: number }> = {}) => ({
    message_id: overrides.messageId ?? 1,
    chat: { id: overrides.chatId ?? 100, type: 'private' as const },
    date: 1,
    from: { id: overrides.fromId ?? 42, is_bot: false, first_name: 'Alice', username: 'alice' },
    text: 'hello',
  });

  beforeEach(async () => {
    mockTelegram = new MockTelegramClient();
    mockTelegram.sendMessage.resolves({ message_id: 99, chat: { id: 100 }, date: 1 });

    acquireLockStub = sinon.stub().resolves(true);
    releaseLockStub = sinon.stub().resolves();
    checkThrottleStub = sinon.stub().resolves({ allowed: true, retryAfterMs: 0 });
    queueAddStub = sinon.stub().resolves({ id: 'test-job-1' });

    const module = await esmock('../../src/services/manager-bot.ts', {
      '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: sinon.stub().resolves(null) },
      '../../src/services/conversation-throttle.js': { checkThrottle: checkThrottleStub },
      '../../src/services/conversation-lock.js': { acquireLock: acquireLockStub, releaseLock: releaseLockStub },
      '../../src/queues/manager-queue.js': { managerQueue: { add: queueAddStub } },
    });
    enqueueManagerMessage = module.enqueueManagerMessage;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('enqueues job when lock is acquired', async () => {
    const message = makeMessage({ messageId: 55 });
    await enqueueManagerMessage(message, mockTelegram, MANAGER_TOKEN, BOT_USERNAME);
    expect(queueAddStub.calledOnce).to.be.true;
    expect(queueAddStub.firstCall.args[0]).to.equal('manager-message');
    expect(queueAddStub.firstCall.args[1].conversationId).to.equal('manager:42');
  });

  it('sends "still working" reply and does NOT call queue.add when lock is not acquired', async () => {
    acquireLockStub.resolves(false);
    const message = makeMessage();
    await enqueueManagerMessage(message, mockTelegram, MANAGER_TOKEN, BOT_USERNAME);
    expect(queueAddStub.called).to.be.false;
    expect(mockTelegram.sendMessage.calledOnce).to.be.true;
    const text: string = mockTelegram.sendMessage.firstCall.args[2];
    expect(text).to.include("still working");
  });

  it('releases lock and sends error message when queue.add fails', async () => {
    queueAddStub.rejects(new Error('Redis enqueue error'));
    const message = makeMessage();
    await enqueueManagerMessage(message, mockTelegram, MANAGER_TOKEN, BOT_USERNAME);
    expect(releaseLockStub.calledOnce).to.be.true;
    expect(mockTelegram.sendMessage.calledOnce).to.be.true;
    const text: string = mockTelegram.sendMessage.firstCall.args[2];
    expect(text).to.include('Sorry');
  });

  it('ignores message when from is missing', async () => {
    const message = { message_id: 1, chat: { id: 100, type: 'private' as const }, date: 1, text: 'hi' };
    await enqueueManagerMessage(message as any, mockTelegram, MANAGER_TOKEN, BOT_USERNAME);
    expect(queueAddStub.called).to.be.false;
    expect(mockTelegram.sendMessage.called).to.be.false;
  });
});

describe('processManagerMessage', () => {
  let processManagerMessage: any;
  let mockTelegram: MockTelegramClient;
  let agentServiceStub: {
    chatStream: sinon.SinonStub;
  };
  let findManagedBotByOwnerStub: sinon.SinonStub;

  const MANAGER_TOKEN = 'manager-token-abc';
  const MANAGER_BOT_ID = 'manager';
  const BASE_URL = 'https://example.com';
  const BOT_USERNAME = 'hellominds_bot';

  const makeJobData = (overrides: Partial<{ userId: number; botStatus: string }> = {}) => ({
    conversationId: `manager:${overrides.userId ?? 42}`,
    userId: overrides.userId ?? 42,
    chatId: 100,
    messageId: 1,
    text: 'hello',
    firstName: 'Alice',
    username: 'alice',
  });

  beforeEach(async () => {
    mockTelegram = new MockTelegramClient();
    mockTelegram.sendMessage.resolves({ message_id: 99, chat: { id: 100 }, date: 1 });

    async function* defaultStream() { yield 'AI reply'; }
    agentServiceStub = {
      chatStream: sinon.stub().returns(defaultStream()),
    };

    findManagedBotByOwnerStub = sinon.stub().resolves(null);

    const module = await esmock('../../src/services/manager-bot.ts', {
      '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: findManagedBotByOwnerStub },
      '../../src/services/conversation-throttle.js': { checkThrottle: sinon.stub().resolves({ allowed: true, retryAfterMs: 0 }) },
      '../../src/services/conversation-lock.js': { acquireLock: sinon.stub().resolves(true), releaseLock: sinon.stub().resolves() },
      '../../src/queues/manager-queue.js': { managerQueue: { add: sinon.stub().resolves({ id: 'j1' }) } },
    });
    processManagerMessage = module.processManagerMessage;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('routes to onboarding system prompt when no bot', async () => {
    findManagedBotByOwnerStub.resolves(null);
    const jobData = makeJobData();
    await processManagerMessage(jobData, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);
    const systemPrompt: string = agentServiceStub.chatStream.firstCall.args[3];
    expect(systemPrompt).to.include('general assistant');
  });

  it('routes to settings system prompt when bot is ACTIVE', async () => {
    findManagedBotByOwnerStub.resolves({ status: 'ACTIVE', bot_username: 'alicebot' });
    const jobData = makeJobData();
    await processManagerMessage(jobData, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);
    const systemPrompt: string = agentServiceStub.chatStream.firstCall.args[3];
    expect(systemPrompt).to.include('account creation');
  });

  it('calls agentService.chatStream and sends reply', async () => {
    async function* stream() { yield 'Hello world'; }
    agentServiceStub.chatStream.returns(stream());
    const jobData = makeJobData();
    await processManagerMessage(jobData, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);
    expect(agentServiceStub.chatStream.calledOnce).to.be.true;
    expect(mockTelegram.sendMessage.calledOnce).to.be.true;
    const text: string = mockTelegram.sendMessage.firstCall.args[2];
    expect(text).to.include('Hello world');
  });

  it('sends error fallback when chatStream throws', async () => {
    async function* throwingStream(): AsyncGenerator<string> { throw new Error('LLM down'); yield ''; }
    agentServiceStub.chatStream.returns(throwingStream());
    const jobData = makeJobData();
    await processManagerMessage(jobData, mockTelegram, agentServiceStub, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);
    expect(mockTelegram.sendMessage.calledOnce).to.be.true;
    const fallback: string = mockTelegram.sendMessage.firstCall.args[2];
    expect(fallback).to.include('Sorry');
    expect(fallback).to.include('try again');
  });

  it('still calls chatStream when getToolsetState rejects (fail-open)', async () => {
    async function* freshStream() { yield 'AI reply'; }
    const freshChatStream = sinon.stub().returns(freshStream());
    const freshAgentService = { chatStream: freshChatStream };

    const mod = await esmock('../../src/services/manager-bot.ts', {
      '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: findManagedBotByOwnerStub },
      '../../src/db/queries/conversations.js': {
        getToolsetState: sinon.stub().rejects(new Error('Redis timeout')),
      },
      '../../src/services/tool-tier.js': {
        resolveToolTier: sinon.stub().returns('base'),
        getToolsForTier: sinon.stub().returns([]),
      },
      '../../src/services/conversation-throttle.js': { checkThrottle: sinon.stub().resolves({ allowed: true, retryAfterMs: 0 }) },
      '../../src/services/conversation-lock.js': { acquireLock: sinon.stub().resolves(true), releaseLock: sinon.stub().resolves() },
      '../../src/queues/manager-queue.js': { managerQueue: { add: sinon.stub().resolves({ id: 'j1' }) } },
    });

    const jobData = makeJobData();
    await mod.processManagerMessage(jobData, mockTelegram, freshAgentService, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    // Fail-open: chatStream is still called despite getToolsetState error
    expect(freshChatStream.calledOnce).to.be.true;
    // Message is still sent
    expect(mockTelegram.sendMessage.calledOnce).to.be.true;
    // When getToolsetState rejects, toolsetState falls back to {} — arg[5] should be {}
    expect(freshChatStream.firstCall.args[5]).to.deep.equal({});
  });

  it('passes toolsetState from getToolsetState to chatStream (arg index 5)', async () => {
    async function* freshStream() { yield 'AI reply'; }
    const freshChatStream = sinon.stub().returns(freshStream());
    const freshAgentService = { chatStream: freshChatStream };
    const toolsetData = { timezone: 'America/New_York', email: 'user@example.com' };

    const mod = await esmock('../../src/services/manager-bot.ts', {
      '../../src/db/queries/managed-bots.js': { findManagedBotByOwner: findManagedBotByOwnerStub },
      '../../src/db/queries/conversations.js': {
        getToolsetState: sinon.stub().resolves(toolsetData),
      },
      '../../src/services/tool-tier.js': {
        resolveToolTier: sinon.stub().returns('base'),
        getToolsForTier: sinon.stub().returns([]),
      },
      '../../src/services/conversation-throttle.js': { checkThrottle: sinon.stub().resolves({ allowed: true, retryAfterMs: 0 }) },
      '../../src/services/conversation-lock.js': { acquireLock: sinon.stub().resolves(true), releaseLock: sinon.stub().resolves() },
      '../../src/queues/manager-queue.js': { managerQueue: { add: sinon.stub().resolves({ id: 'j1' }) } },
    });

    const jobData = makeJobData();
    await mod.processManagerMessage(jobData, mockTelegram, freshAgentService, MANAGER_TOKEN, MANAGER_BOT_ID, BASE_URL, BOT_USERNAME);

    expect(freshChatStream.calledOnce).to.be.true;
    // toolsetState is passed verbatim as arg[5] to chatStream (projection happens inside agentNode)
    expect(freshChatStream.firstCall.args[5]).to.deep.equal(toolsetData);
  });
});
