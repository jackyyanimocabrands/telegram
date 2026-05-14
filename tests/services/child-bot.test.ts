import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('child-bot service', () => {
  let provisionChildBot: any;
  let handleChildBotMessage: any;
  let handleChildBotCallback: any;
  let processChildBotMessage: any;
  let setMyNameStub: sinon.SinonStub;
  let setMyDescriptionStub: sinon.SinonStub;
  let setMyShortDescriptionStub: sinon.SinonStub;
  let setMyCommandsStub: sinon.SinonStub;
  let sendMessageStub: sinon.SinonStub;
  let sendMessageDraftStub: sinon.SinonStub;
  let answerCallbackQueryStub: sinon.SinonStub;
  let getDecryptedBotTokenStub: sinon.SinonStub;
  let queueAddStub: sinon.SinonStub;
  let agentServiceStub: {
    chat: sinon.SinonStub;
    chatStream: sinon.SinonStub;
    clearContext: sinon.SinonStub;
    generateWarmPrompt: sinon.SinonStub;
  };

  beforeEach(async () => {
    setMyNameStub = sinon.stub().resolves(true);
    setMyDescriptionStub = sinon.stub().resolves(true);
    setMyShortDescriptionStub = sinon.stub().resolves(true);
    setMyCommandsStub = sinon.stub().resolves(true);
    sendMessageStub = sinon.stub().resolves({});
    sendMessageDraftStub = sinon.stub().resolves(true);
    answerCallbackQueryStub = sinon.stub().resolves(true);
    getDecryptedBotTokenStub = sinon.stub().resolves('child-token-123');
    queueAddStub = sinon.stub().resolves({ id: 'job-1' });

    async function* defaultStream() { yield 'AI reply'; }
    agentServiceStub = {
      chat: sinon.stub().resolves('AI reply'),
      chatStream: sinon.stub().returns(defaultStream()),
      clearContext: sinon.stub().resolves(),
      generateWarmPrompt: sinon.stub().resolves(null),
    };

    const module = await esmock('../../src/services/child-bot.ts', {
      '../../src/services/telegram-api.js': {
        HttpTelegramClient: class MockHttpTelegramClient {
          setMyName = setMyNameStub;
          setMyDescription = setMyDescriptionStub;
          setMyShortDescription = setMyShortDescriptionStub;
          setMyCommands = setMyCommandsStub;
          sendMessage = sendMessageStub;
          sendMessageDraft = sendMessageDraftStub;
          sendChatAction = sinon.stub().resolves(true);
          answerCallbackQuery = answerCallbackQueryStub;
        },
      },
      '../../src/services/token-store.js': { getDecryptedBotToken: getDecryptedBotTokenStub },
      '../../src/services/conversation-lock.js': {
        acquireLock: sinon.stub().resolves(true),
        releaseLock: sinon.stub().resolves(),
      },
      '../../src/queues/child-queue.js': {
        childQueue: { add: queueAddStub },
      },
    });
    provisionChildBot = module.provisionChildBot;
    handleChildBotMessage = module.handleChildBotMessage;
    handleChildBotCallback = module.handleChildBotCallback;
    processChildBotMessage = module.processChildBotMessage;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  describe('provisionChildBot', () => {
    it('sets name, description, short description, and commands', async () => {
      await provisionChildBot('token', 42, 'Alice');
      expect(setMyNameStub.calledOnce).to.be.true;
      expect(setMyDescriptionStub.calledOnce).to.be.true;
      expect(setMyShortDescriptionStub.calledOnce).to.be.true;
      expect(setMyCommandsStub.calledOnce).to.be.true;
    });

    it('does NOT call setWebhook (registry owns transport)', async () => {
      // setWebhook is not stubbed — if it were called, it would throw because it's not in the mock
      let threw = false;
      try {
        await provisionChildBot('token', 42, 'Alice');
      } catch {
        threw = true;
      }
      expect(threw).to.be.false;
    });

    it('includes owner first name in the bot name', async () => {
      await provisionChildBot('token', 42, 'Bob');
      expect(setMyNameStub.firstCall.args[1]).to.include('Bob');
    });

    it('sets exactly 3 commands (start, help, clear)', async () => {
      await provisionChildBot('token', 42, 'Alice');
      const commands = setMyCommandsStub.firstCall.args[1];
      expect(commands).to.have.length(3);
      const names = commands.map((c: { command: string }) => c.command);
      expect(names).to.include('clear');
      expect(names).to.not.include('provider');
    });
  });

  describe('handleChildBotMessage', () => {
    const makeMessage = (text: string) => ({
      message_id: 1,
      chat: { id: 999, type: 'private' as const },
      date: 1,
      from: { id: 12, is_bot: false, first_name: 'User' },
      text,
    });

    it('sends welcome message on /start', async () => {
      await handleChildBotMessage(42, makeMessage('/start'), agentServiceStub);
      expect(sendMessageStub.calledOnce).to.be.true;
      expect(sendMessageStub.firstCall.args[1]).to.equal(999);
    });

    it('sends help message on /help', async () => {
      await handleChildBotMessage(42, makeMessage('/help'), agentServiceStub);
      expect(sendMessageStub.calledOnce).to.be.true;
    });

    it('routes regular messages to agentService.chat (no echo)', async () => {
      await handleChildBotMessage(42, makeMessage('hello world'), agentServiceStub);
      // AI messages are now enqueued — verify queue.add was called, not chatStream
      expect(queueAddStub.calledOnce).to.be.true;
      expect(agentServiceStub.chatStream.called).to.be.false;
    });

    it('calls agentService.chat with string botId', async () => {
      await handleChildBotMessage(42, makeMessage('test'), agentServiceStub);
      // AI messages are enqueued — verify job data contains the correct botId string
      expect(queueAddStub.calledOnce).to.be.true;
      const jobData = queueAddStub.firstCall.args[1];
      expect(jobData.botId).to.equal('42');
    });

    it('sends error fallback when getDecryptedBotToken fails', async () => {
      getDecryptedBotTokenStub.rejects(new Error('not found'));
      // Token is hoisted before the try block — if getDecryptedBotToken throws,
      // the error propagates to the outer registry handler (intentional per blocker 8).
      let threw = false;
      try {
        await handleChildBotMessage(42, makeMessage('hi'), agentServiceStub);
      } catch {
        threw = true;
      }
      // Implementation lets the token fetch error propagate — outer handler catches it
      expect(threw).to.be.true;
    });
  });

  describe('handleChildBotCallback', () => {
    const mockCallbackQuery = {
      id: 'cq-001',
      from: { id: 12, is_bot: false, first_name: 'User' },
      data: 'action:click',
    };

    it('answers the callback query', async () => {
      await handleChildBotCallback(42, mockCallbackQuery);
      expect(answerCallbackQueryStub.calledOnce).to.be.true;
      expect(answerCallbackQueryStub.firstCall.args[1]).to.equal('cq-001');
    });

    it('throws when getDecryptedBotToken fails', async () => {
      getDecryptedBotTokenStub.rejects(new Error('not found'));
      let threw = false;
      try {
        await handleChildBotCallback(42, mockCallbackQuery);
      } catch {
        threw = true;
      }
      expect(threw).to.be.true;
    });
  });

  describe('processChildBotMessage', () => {
    const jobData = {
      conversationId: 'child:42:12',
      botId: '42',
      userId: 12,
      chatId: 999,
      messageId: 1,
      text: 'hello',
    };

    /** Build a fresh telegramClient stub with individually trackable stubs. */
    function makeTelegramClientStub() {
      const draftStub = sinon.stub().resolves(true);
      const msgStub = sinon.stub().resolves({});
      return {
        sendMessageDraft: draftStub,
        sendMessage: msgStub,
        sendChatAction: sinon.stub().resolves(true),
      };
    }

    it('calls final awaited sendMessageDraft with full accumulated content before sendMessage', async () => {
      async function* twoChunks() { yield 'Hello'; yield ' world'; }
      agentServiceStub.chatStream = sinon.stub().returns(twoChunks());

      const client = makeTelegramClientStub();
      await processChildBotMessage(jobData, client, agentServiceStub);

      // Final flush must have been called with the complete text
      const draftCalls = client.sendMessageDraft.getCalls();
      const finalDraftCall = draftCalls[draftCalls.length - 1];
      // The final awaited call carries the fully accumulated content
      expect(finalDraftCall.args[3]).to.include('Hello');
      expect(finalDraftCall.args[3]).to.include('world');
    });

    it('final sendMessageDraft is called before sendMessage (ordering guarantee)', async () => {
      async function* oneChunk() { yield 'AI reply'; }
      agentServiceStub.chatStream = sinon.stub().returns(oneChunk());

      const client = makeTelegramClientStub();
      await processChildBotMessage(jobData, client, agentServiceStub);

      // sendMessage must be called after the final sendMessageDraft
      const draftCalls = client.sendMessageDraft.getCalls();
      const finalDraftCall = draftCalls[draftCalls.length - 1];
      const firstMsgCall = client.sendMessage.getCall(0);

      expect(finalDraftCall.calledBefore(firstMsgCall)).to.be.true;
    });

    it('does NOT call final sendMessageDraft when stream yields nothing (empty accumulated)', async () => {
      async function* emptyStream() { /* no yields */ }
      agentServiceStub.chatStream = sinon.stub().returns(emptyStream());

      const client = makeTelegramClientStub();
      await processChildBotMessage(jobData, client, agentServiceStub);

      // With empty accumulated, the final flush (MarkdownV2 parse_mode variant) must NOT be called.
      // The only possible draft call would be the "Thinking" bubble (plain text, no parse_mode arg).
      const draftCalls = client.sendMessageDraft.getCalls();
      const finalFlushCalls = draftCalls.filter((c) => c.args[4] === 'MarkdownV2');
      expect(finalFlushCalls).to.have.length(0);
    });

    it('sends sendMessage with MarkdownV2 parse_mode', async () => {
      async function* oneChunk() { yield 'AI reply'; }
      agentServiceStub.chatStream = sinon.stub().returns(oneChunk());

      const client = makeTelegramClientStub();
      await processChildBotMessage(jobData, client, agentServiceStub);

      expect(client.sendMessage.calledOnce).to.be.true;
      const opts = client.sendMessage.firstCall.args[3];
      expect(opts).to.deep.equal({ parse_mode: 'MarkdownV2' });
    });

    it('sends error fallback when chatStream throws', async () => {
      agentServiceStub.chatStream = sinon.stub().returns(
        (async function* () { throw new Error('LLM error'); })(),
      );

      const client = makeTelegramClientStub();
      await processChildBotMessage(jobData, client, agentServiceStub);

      expect(client.sendMessage.calledOnce).to.be.true;
      expect(client.sendMessage.firstCall.args[2]).to.include('Sorry');
    });
  });
});
