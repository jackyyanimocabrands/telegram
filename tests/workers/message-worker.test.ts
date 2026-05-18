import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('processEmailVerificationJob', () => {
  let processEmailVerificationJob: any;
  let getTokenStub: sinon.SinonStub;
  let markNotifiedStub: sinon.SinonStub;
  let sendMessageStub: sinon.SinonStub;

  const MANAGER_BOT_ID = 'manager-bot-123';
  const MANAGER_BOT_TOKEN = 'manager-token-abc';

  function makeDeps(overrides: Partial<{ managerBotId: string; managerBotToken: string }> = {}) {
    return {
      telegram: { sendMessage: sendMessageStub },
      agentService: {},
      managerBotToken: overrides.managerBotToken ?? MANAGER_BOT_TOKEN,
      managerBotId: overrides.managerBotId ?? MANAGER_BOT_ID,
      baseUrl: 'https://example.com',
      botUsername: 'TestBot',
    };
  }

  function makeJob(overrides: Partial<{ botId: string; chatId: number; jti: string; userId: number }> = {}) {
    return {
      id: 'job-001',
      data: {
        botId: overrides.botId ?? MANAGER_BOT_ID,
        chatId: overrides.chatId ?? 99887766,
        jti: overrides.jti ?? 'test-jti-uuid',
        userId: overrides.userId ?? 99887766,
      },
    };
  }

  function makeTokenRow(email: string = 'user@example.com') {
    return {
      jti: 'test-jti-uuid',
      email,
      bot_id: MANAGER_BOT_ID,
      user_id: 99887766,
      status: 'verified' as const,
      expires_at: new Date(Date.now() + 3600_000),
      verified_at: new Date(),
      notified_at: null,
      created_at: new Date(),
    };
  }

  beforeEach(async () => {
    getTokenStub = sinon.stub();
    markNotifiedStub = sinon.stub().resolves(1);
    sendMessageStub = sinon.stub().resolves();

    const mod = await esmock('../../src/workers/message-worker.ts', {
      '../../src/db/queries/email-verification-tokens.js': {
        getToken: getTokenStub,
        markNotified: markNotifiedStub,
      },
      // Stub out other deps that are imported at module level
      '../../src/services/conversation-lock.js': {
        releaseLock: sinon.stub().resolves(),
      },
      '../../src/services/manager-bot.js': {
        processManagerMessage: sinon.stub().resolves(),
      },
      '../../src/queues/email-verification-queue.js': {
        EMAIL_VERIFICATION_QUEUE_NAME: 'email-verification',
      },
    });

    processEmailVerificationJob = mod.processEmailVerificationJob;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── 1. getToken returns null → returns early ──────────────────────────────

  it('1. returns early when getToken returns null — sendMessage and markNotified NOT called', async () => {
    getTokenStub.resolves(null);
    await processEmailVerificationJob(makeJob(), makeDeps());

    expect(sendMessageStub.called).to.be.false;
    expect(markNotifiedStub.called).to.be.false;
  });

  // ── 3. Happy path: sendMessage with escaped email, markNotified called ────

  it('3. happy path: sendMessage called with MarkdownV2-escaped email, markNotified called with jti', async () => {
    const email = 'user.name@example.com';
    getTokenStub.resolves(makeTokenRow(email));
    const job = makeJob();
    const deps = makeDeps();

    await processEmailVerificationJob(job, deps);

    expect(sendMessageStub.calledOnce).to.be.true;
    const [token, chatId, text] = sendMessageStub.firstCall.args;
    expect(token).to.equal(MANAGER_BOT_TOKEN);
    expect(chatId).to.equal(job.data.chatId);
    // Dots in email should be escaped as \. in MarkdownV2
    expect(text).to.include('user\\.name@example\\.com');

    expect(markNotifiedStub.calledOnceWith(job.data.jti)).to.be.true;
  });

  // ── 4. sendMessage throws → markNotified NOT called, error propagates ─────

  it('4. sendMessage throws → markNotified NOT called, error propagates', async () => {
    getTokenStub.resolves(makeTokenRow());
    sendMessageStub.rejects(new Error('Telegram API error'));

    let threw = false;
    try {
      await processEmailVerificationJob(makeJob(), makeDeps());
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.include('Telegram API error');
    }
    expect(threw).to.be.true;
    expect(markNotifiedStub.called).to.be.false;
  });

  // ── 5. markNotified returns 0 (race) → logs warn but does NOT throw ───────

  it('5. markNotified returns 0 (race) → does NOT throw', async () => {
    getTokenStub.resolves(makeTokenRow());
    markNotifiedStub.resolves(0);

    // Should resolve without throwing
    await processEmailVerificationJob(makeJob(), makeDeps());

    expect(sendMessageStub.calledOnce).to.be.true;
    expect(markNotifiedStub.calledOnce).to.be.true;
  });

  // ── 6. Email with special MarkdownV2 chars escaped correctly ──────────────

  it('6. email user.name+tag@x.com is fully escaped for MarkdownV2 in sendMessage call', async () => {
    const email = 'user.name+tag@x.com';
    getTokenStub.resolves(makeTokenRow(email));

    await processEmailVerificationJob(makeJob(), makeDeps());

    expect(sendMessageStub.calledOnce).to.be.true;
    const [, , text] = sendMessageStub.firstCall.args;
    // All special MarkdownV2 chars in the email should be escaped
    // . → \. , + → \+, @ stays as-is (not a MarkdownV2 reserved char per the regex)
    expect(text).to.include('user\\.name\\+tag@x\\.com');
  });
});
