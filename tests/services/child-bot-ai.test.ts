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
  let sendMessageStub: sinon.SinonStub;
  let getDecryptedBotTokenStub: sinon.SinonStub;
  let agentServiceStub: {
    chat: sinon.SinonStub;
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

  beforeEach(async () => {
    sendMessageStub = sinon.stub().resolves({});
    getDecryptedBotTokenStub = sinon.stub().resolves(TOKEN);

    agentServiceStub = {
      chat: sinon.stub().resolves('AI response'),
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
          answerCallbackQuery = sinon.stub().resolves(true);
        },
      },
      '../../src/services/token-store.js': { getDecryptedBotToken: getDecryptedBotTokenStub },
    });
    handleChildBotMessage = module.handleChildBotMessage;
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

  // ── Regular message → AI chat ─────────────────────────────────────────────

  it('regular message calls agentService.chat with correct args', async () => {
    await handleChildBotMessage(BOT_ID, makeMessage('hello there'), agentServiceStub);

    expect(agentServiceStub.chat.calledOnce).to.be.true;
    expect(agentServiceStub.chat.firstCall.args[0]).to.equal(String(BOT_ID));
    expect(agentServiceStub.chat.firstCall.args[1]).to.equal(USER_ID);
    expect(agentServiceStub.chat.firstCall.args[2]).to.equal('hello there');
  });

  it('regular message sends AI reply to user', async () => {
    agentServiceStub.chat.resolves('This is the AI answer');
    await handleChildBotMessage(BOT_ID, makeMessage('what is 2+2?'), agentServiceStub);

    expect(sendMessageStub.calledOnce).to.be.true;
    expect(sendMessageStub.firstCall.args[1]).to.equal(CHAT_ID);
    expect(sendMessageStub.firstCall.args[2]).to.equal('This is the AI answer');
  });

  it('error in agentService.chat sends fallback error message', async () => {
    agentServiceStub.chat.rejects(new Error('LLM offline'));
    await handleChildBotMessage(BOT_ID, makeMessage('help me'), agentServiceStub);

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
});
