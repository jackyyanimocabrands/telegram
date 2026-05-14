import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

/**
 * AI-integration tests for child-bot handlers.
 * These complement the existing child-bot.test.ts which covers provisioning
 * and the basic /start, /help command paths.
 *
 * All tests use constructor-injection style stubs — no live DB or network.
 */
describe('child-bot AI integration', () => {
  let handleChildBotMessage: any;
  let processChildBotMessage: any;
  let sendMessageStub: sinon.SinonStub;
  let sendMessageDraftStub: sinon.SinonStub;
  let sendChatActionStub: sinon.SinonStub;
  let getDecryptedBotTokenStub: sinon.SinonStub;
  let acquireLockStub: sinon.SinonStub;
  let releaseLockStub: sinon.SinonStub;
  let queueAddStub: sinon.SinonStub;
  let agentServiceStub: {
    chat: sinon.SinonStub;
    chatStream: sinon.SinonStub;
    clearContext: sinon.SinonStub;
    switchProvider: sinon.SinonStub;
    generateWarmPrompt: sinon.SinonStub;
  };

  const BOT_ID = 42;
  const CHAT_ID = 999;
  const USER_ID = 12;
  const TOKEN = 'child-token-123';

  const makeMessage = (text: string, from?: any) => ({
    message_id: 1,
    chat: { id: CHAT_ID, type: 'private' as const },
    date: 1,
    from: from ?? { id: USER_ID, is_bot: false, first_name: 'User' },
    text,
  });

  const makeJobData = (text = 'hello there') => ({
    conversationId: `child:${BOT_ID}:${USER_ID}`,
    botId: String(BOT_ID),
    userId: USER_ID,
    chatId: CHAT_ID,
    messageId: 1,
    text,
  });

  /** Fake TelegramClient for processChildBotMessage tests */
  const makeFakeTelegram = () => ({
    sendMessage: sendMessageStub,
    sendMessageDraft: sendMessageDraftStub,
    sendChatAction: sendChatActionStub,
    answerCallbackQuery: sinon.stub().resolves(true),
    setMyName: sinon.stub().resolves(true),
    setMyDescription: sinon.stub().resolves(true),
    setMyShortDescription: sinon.stub().resolves(true),
    setMyCommands: sinon.stub().resolves(true),
    setWebhook: sinon.stub().resolves(true),
    deleteWebhook: sinon.stub().resolves(true),
    getUpdates: sinon.stub().resolves([]),
  });

  beforeEach(async () => {
    sendMessageStub = sinon.stub().resolves({});
    sendMessageDraftStub = sinon.stub().resolves(true);
    sendChatActionStub = sinon.stub().resolves(true);
    getDecryptedBotTokenStub = sinon.stub().resolves(TOKEN);
    acquireLockStub = sinon.stub().resolves(true);
    releaseLockStub = sinon.stub().resolves();
    queueAddStub = sinon.stub().resolves({ id: 'job-1' });

    async function* defaultStream() { yield 'AI response'; }
    agentServiceStub = {
      chat: sinon.stub().resolves('AI response'),
      chatStream: sinon.stub().returns(defaultStream()),
      clearContext: sinon.stub().resolves(),
      switchProvider: sinon.stub().resolves(),
      generateWarmPrompt: sinon.stub().resolves(null),
    };

    const module = await esmock('../../src/services/child-bot.ts', {
      '../../src/services/telegram-api.js': {
        HttpTelegramClient: class MockHttpTelegramClient {
          setMyName = sinon.stub().resolves(true);
          setMyDescription = sinon.stub().resolves(true);
          setMyShortDescription = sinon.stub().resolves(true);
          setMyCommands = sinon.stub().resolves(true);
          sendMessage = sendMessageStub;
          sendMessageDraft = sendMessageDraftStub;
          sendChatAction = sendChatActionStub;
          answerCallbackQuery = sinon.stub().resolves(true);
        },
      },
      '../../src/services/token-store.js': { getDecryptedBotToken: getDecryptedBotTokenStub },
      '../../src/services/conversation-lock.js': { acquireLock: acquireLockStub, releaseLock: releaseLockStub },
      '../../src/queues/child-queue.js': { childQueue: { add: queueAddStub } },
    });
    handleChildBotMessage = module.handleChildBotMessage;
    processChildBotMessage = module.processChildBotMessage;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── /clear command ────────────────────────────────────────────────────────

  it('/clear calls agentService.clearContext with correct botId string and userId', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/clear'), agentServiceStub);

    expect(agentServiceStub.clearContext.calledOnce).to.be.true;
    expect(agentServiceStub.clearContext.firstCall.args[0]).to.equal(String(BOT_ID));
    expect(agentServiceStub.clearContext.firstCall.args[1]).to.equal(USER_ID);
  });

  it('/clear sends confirmation reply', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/clear'), agentServiceStub);

    expect(sendMessageStub.calledOnce).to.be.true;
    const replyText: string = sendMessageStub.firstCall.args[2];
    expect(replyText).to.include('cleared');
  });

  // ── /provider command ─────────────────────────────────────────────────────

  it('/provider openai gpt-4o calls agentService.switchProvider with correct args', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/provider openai gpt-4o'), agentServiceStub);

    expect(agentServiceStub.switchProvider.calledOnce).to.be.true;
    expect(agentServiceStub.switchProvider.firstCall.args[0]).to.equal(String(BOT_ID));
    expect(agentServiceStub.switchProvider.firstCall.args[1]).to.equal(USER_ID);
    expect(agentServiceStub.switchProvider.firstCall.args[2]).to.equal('openai');
    expect(agentServiceStub.switchProvider.firstCall.args[3]).to.equal('gpt-4o');
  });

  it('/provider openai (no model) calls agentService.switchProvider with a default model', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/provider openai'), agentServiceStub);

    expect(agentServiceStub.switchProvider.calledOnce).to.be.true;
    const model: string = agentServiceStub.switchProvider.firstCall.args[3];
    expect(model.length).to.be.greaterThan(0);
  });

  it('/provider openai gpt-99 (unknown model) sends "Unknown model" reply and falls back to gpt-4o', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/provider openai gpt-99'), agentServiceStub);

    // First sendMessage call should mention the unknown model or the fallback
    expect(sendMessageStub.called).to.be.true;
    const firstReply: string = sendMessageStub.firstCall.args[2];
    expect(firstReply.toLowerCase()).to.satisfy(
      (s: string) => s.includes('unknown model') || s.includes('gpt-4o'),
      'reply should mention "Unknown model" or the fallback model name',
    );

    // switchProvider must be called with the fallback gpt-4o, never gpt-99
    expect(agentServiceStub.switchProvider.calledOnce).to.be.true;
    expect(agentServiceStub.switchProvider.firstCall.args[3]).to.equal('gpt-4o');
    expect(agentServiceStub.switchProvider.firstCall.args[3]).to.not.equal('gpt-99');
  });

  it('/provider openai sends success confirmation reply', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/provider openai gpt-4o'), agentServiceStub);

    expect(sendMessageStub.calledOnce).to.be.true;
    const replyText: string = sendMessageStub.firstCall.args[2];
    expect(replyText).to.include('Switched to openai');
  });

  it('/provider with unsupported provider name replies with error message', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/provider fakeai'), agentServiceStub);

    expect(sendMessageStub.calledOnce).to.be.true;
    const replyText: string = sendMessageStub.firstCall.args[2];
    expect(replyText).to.include('Unknown provider');
    expect(agentServiceStub.switchProvider.called).to.be.false;
  });

  it('/provider with no args replies with error message', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/provider'), agentServiceStub);

    expect(sendMessageStub.calledOnce).to.be.true;
    const replyText: string = sendMessageStub.firstCall.args[2];
    expect(replyText).to.include('Invalid provider');
    expect(agentServiceStub.switchProvider.called).to.be.false;
  });

  // ── Regular message → AI chat (enqueue path) ──────────────────────────────

  it('regular message calls agentService.chatStream with correct args', async () => {
    // processChildBotMessage is the worker function that calls chatStream
    await processChildBotMessage(makeJobData('hello there'), makeFakeTelegram(), agentServiceStub);

    expect(agentServiceStub.chatStream.calledOnce).to.be.true;
    expect(agentServiceStub.chatStream.firstCall.args[0]).to.equal(String(BOT_ID));
    expect(agentServiceStub.chatStream.firstCall.args[1]).to.equal(USER_ID);
    expect(agentServiceStub.chatStream.firstCall.args[2]).to.equal('hello there');
  });

  it('sends thinking bubble after 250ms delay before stream starts', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const promise = processChildBotMessage(makeJobData('hello there'), makeFakeTelegram(), agentServiceStub);
      await clock.tickAsync(300); // advance past 250ms
      await promise;
      expect(sendMessageDraftStub.calledWith(TOKEN, CHAT_ID, sinon.match.number, 'Thinking')).to.be.true;
    } finally {
      clock.restore();
    }
  });

  it('sendChatAction typing is called when first token arrives (not before stream)', async () => {
    await processChildBotMessage(makeJobData('hello there'), makeFakeTelegram(), agentServiceStub);

    expect(sendChatActionStub.calledWith(TOKEN, CHAT_ID, 'typing')).to.be.true;
  });

  it('sendMessageDraft is called with MarkdownV2 content during stream (fire-and-forget)', async () => {
    async function* stream() { yield 'Hello world. '; yield 'chunk2'; yield 'chunk3'; }
    agentServiceStub.chatStream.returns(stream());

    await processChildBotMessage(makeJobData('hello'), makeFakeTelegram(), agentServiceStub);

    // At least one draft call with MarkdownV2 content (fire-and-forget during stream)
    const mdCalls = sendMessageDraftStub.args.filter((args: unknown[]) => args[4] === 'MarkdownV2');
    expect(mdCalls.length).to.be.greaterThan(0);
  });

  it('sendMessageDraft during stream shows only complete sentences', async () => {
    async function* stream() {
      yield 'Hello world';
      yield '. ';
      yield 'Partial chunk';
    }
    agentServiceStub.chatStream.returns(stream());

    await processChildBotMessage(makeJobData('hello'), makeFakeTelegram(), agentServiceStub);

    const mdCalls = sendMessageDraftStub.args.filter((args: unknown[]) => args[4] === 'MarkdownV2');
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
      yield 'first';        // now = 4001 → triggers first typing call (4001 - 0 >= 4000)
      nowValue += TYPING_REFRESH_MS + 1; // advance time past refresh threshold
      yield 'second';       // now = 8002 → should trigger second typing call (8002 - 4001 >= 4000)
    }
    agentServiceStub.chatStream.returns(longStream());

    await processChildBotMessage(makeJobData('long question'), makeFakeTelegram(), agentServiceStub);

    dateNowStub.restore();

    // sendChatAction should be called twice: once on first token, once after refresh
    expect(sendChatActionStub.callCount).to.equal(2);
    expect(sendChatActionStub.alwaysCalledWith(TOKEN, CHAT_ID, 'typing')).to.be.true;
  });

  it('regular message sends AI reply to user', async () => {
    async function* stream() { yield 'This is the AI answer'; }
    agentServiceStub.chatStream.returns(stream());
    await processChildBotMessage(makeJobData('what is 2+2?'), makeFakeTelegram(), agentServiceStub);

    expect(sendMessageStub.calledOnce).to.be.true;
    expect(sendMessageStub.firstCall.args[1]).to.equal(CHAT_ID);
    expect(sendMessageStub.firstCall.args[2]).to.equal('This is the AI answer');
  });

  it('error in agentService.chat sends fallback error message', async () => {
    async function* throwingStream(): AsyncGenerator<string> { throw new Error('LLM offline'); yield ''; }
    agentServiceStub.chatStream.returns(throwingStream());
    await processChildBotMessage(makeJobData('help me'), makeFakeTelegram(), agentServiceStub);

    expect(sendMessageStub.calledOnce).to.be.true;
    const replyText: string = sendMessageStub.firstCall.args[2];
    expect(replyText).to.include('Sorry');
    expect(replyText).to.include('try again');
  });

  it('ignores message when from is missing', async () => {
    const messageNoFrom = {
      message_id: 1,
      chat: { id: CHAT_ID, type: 'private' as const },
      date: 1,
      from: undefined,
      text: 'hello',
    };
    await handleChildBotMessage(BOT_ID, messageNoFrom, agentServiceStub);

    expect(agentServiceStub.chat.called).to.be.false;
    expect(sendMessageStub.called).to.be.false;
  });

  // ── /start and /help still work ───────────────────────────────────────────

  it('/start sends greeting without calling agentService.chat', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/start'), agentServiceStub);

    expect(agentServiceStub.chat.called).to.be.false;
    expect(sendMessageStub.calledOnce).to.be.true;
    const greeting: string = sendMessageStub.firstCall.args[2];
    expect(greeting).to.include("Hello");
  });

  it('/help sends command list without calling agentService.chat', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('/help'), agentServiceStub);

    expect(agentServiceStub.chat.called).to.be.false;
    expect(sendMessageStub.calledOnce).to.be.true;
    const help: string = sendMessageStub.firstCall.args[2];
    expect(help).to.include('/clear');
    expect(help).to.include('/provider');
  });

  // ── Message length cap ────────────────────────────────────────────────────

  it('message longer than 2000 chars sends rejection with char count and does NOT call agentService.chat', async () => {
    const oversizedText = 'a'.repeat(2001);
    await handleChildBotMessage(BOT_ID, makeMessage(oversizedText), agentServiceStub);

    expect(agentServiceStub.chat.called).to.be.false;
    expect(sendMessageStub.calledOnce).to.be.true;
    const replyText: string = sendMessageStub.firstCall.args[2];
    // Reply must mention the actual char count (2001)
    expect(replyText).to.include('2001');
  });

  it('sendMessageDraft failure does not prevent final sendMessage', async () => {
    // make sendMessageDraft always throw
    sendMessageDraftStub.rejects(new Error('draft API unavailable'));
    async function* stream() { yield 'safe reply'; }
    agentServiceStub.chatStream.returns(stream());

    await processChildBotMessage(makeJobData('hello'), makeFakeTelegram(), agentServiceStub);

    // final sendMessage must still be called with the AI reply
    expect(sendMessageStub.called).to.be.true;
    const text: string = sendMessageStub.firstCall.args[2];
    expect(text).to.include('safe reply');
  });
});
