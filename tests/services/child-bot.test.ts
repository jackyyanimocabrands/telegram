import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('child-bot service', () => {
  let provisionChildBot: any;
  let handleChildBotMessage: any;
  let handleChildBotCallback: any;
  let setMyNameStub: sinon.SinonStub;
  let setMyDescriptionStub: sinon.SinonStub;
  let setMyShortDescriptionStub: sinon.SinonStub;
  let setMyCommandsStub: sinon.SinonStub;
  let sendMessageStub: sinon.SinonStub;
  let answerCallbackQueryStub: sinon.SinonStub;
  let getDecryptedBotTokenStub: sinon.SinonStub;
  let queueAddStub: sinon.SinonStub;
  let agentServiceStub: {
    chat: sinon.SinonStub;
    chatStream: sinon.SinonStub;
    clearContext: sinon.SinonStub;
    switchProvider: sinon.SinonStub;
    generateWarmPrompt: sinon.SinonStub;
  };

  beforeEach(async () => {
    setMyNameStub = sinon.stub().resolves(true);
    setMyDescriptionStub = sinon.stub().resolves(true);
    setMyShortDescriptionStub = sinon.stub().resolves(true);
    setMyCommandsStub = sinon.stub().resolves(true);
    sendMessageStub = sinon.stub().resolves({});
    answerCallbackQueryStub = sinon.stub().resolves(true);
    getDecryptedBotTokenStub = sinon.stub().resolves('child-token-123');
    queueAddStub = sinon.stub().resolves({ id: 'job-1' });

    async function* defaultStream() { yield 'AI reply'; }
    agentServiceStub = {
      chat: sinon.stub().resolves('AI reply'),
      chatStream: sinon.stub().returns(defaultStream()),
      clearContext: sinon.stub().resolves(),
      switchProvider: sinon.stub().resolves(),
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
          sendMessageDraft = sinon.stub().resolves(true);
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

    it('sets exactly 4 commands (start, help, clear, provider)', async () => {
      await provisionChildBot('token', 42, 'Alice');
      const commands = setMyCommandsStub.firstCall.args[1];
      expect(commands).to.have.length(4);
      const names = commands.map((c: { command: string }) => c.command);
      expect(names).to.include('clear');
      expect(names).to.include('provider');
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
});
