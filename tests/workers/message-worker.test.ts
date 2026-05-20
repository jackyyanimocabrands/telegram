import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('processEmailVerificationJob', () => {
  let processEmailVerificationJob: any;
  let getTokenStub: sinon.SinonStub;
  let markNotifiedStub: sinon.SinonStub;
  let sendMessageStub: sinon.SinonStub;
  let acquireLockStub: sinon.SinonStub;
  let releaseLockStub: sinon.SinonStub;
  let managerQueueAddStub: sinon.SinonStub;
  let mod: any;

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
      managerQueue: { add: managerQueueAddStub },
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
    acquireLockStub = sinon.stub().resolves(true);
    releaseLockStub = sinon.stub().resolves();
    managerQueueAddStub = sinon.stub().resolves({ id: 'synthetic-job-1' });

    mod = await esmock('../../src/workers/message-worker.ts', {
      '../../src/db/queries/email-verification-tokens.js': {
        getToken: getTokenStub,
        markNotified: markNotifiedStub,
      },
      '../../src/services/conversation-lock.js': {
        releaseLock: releaseLockStub,
        acquireLock: acquireLockStub,
      },
      '../../src/queues/manager-queue.js': {
        managerQueue: { add: managerQueueAddStub },
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
    await esmock.purge(mod);
    sinon.restore();
  });

  // ── 1. getToken returns null → returns early ──────────────────────────────

  it('1. returns early when getToken returns null — sendMessage and markNotified NOT called', async () => {
    getTokenStub.resolves(null);
    await processEmailVerificationJob(makeJob(), makeDeps());

    expect(sendMessageStub.called).to.be.false;
    expect(markNotifiedStub.called).to.be.false;
  });

  // ── 3. Happy path: sendMessage with escaped email (short CTA), markNotified called ────

  it('3. happy path: sendMessage suppressed, markNotified called with jti', async () => {
    const email = 'user.name@example.com';
    getTokenStub.resolves(makeTokenRow(email));
    const job = makeJob();
    const deps = makeDeps();

    await processEmailVerificationJob(job, deps);

    // sendMessage is suppressed — synthetic [email_verified] job triggers the agent instead
    expect(sendMessageStub.called).to.be.false;
    // Suppressed assertion: exact CTA format
    // expect(text).to.equal('✅ Email *user\\.name@example\\.com* verified\\!');

    expect(markNotifiedStub.calledOnceWith(job.data.jti)).to.be.true;
  });

  // ── 4. sendMessage is suppressed — markNotified IS called ───────────────────

  it('4. sendMessage suppressed → markNotified IS called, resolves without error', async () => {
    getTokenStub.resolves(makeTokenRow());

    await processEmailVerificationJob(makeJob(), makeDeps());

    expect(sendMessageStub.called).to.be.false;
    expect(markNotifiedStub.calledOnce).to.be.true;
  });

  // ── 5. markNotified returns 0 (race) → logs warn but does NOT throw ───────

  it('5. markNotified returns 0 (race) → does NOT throw', async () => {
    getTokenStub.resolves(makeTokenRow());
    markNotifiedStub.resolves(0);

    // Should resolve without throwing
    await processEmailVerificationJob(makeJob(), makeDeps());

    // sendMessage is suppressed
    expect(sendMessageStub.called).to.be.false;
    expect(markNotifiedStub.calledOnce).to.be.true;
  });

  // ── 6. Email with special MarkdownV2 chars escaped correctly ──────────────

  it('6. email user.name+tag@x.com — sendMessage suppressed, markNotified still called', async () => {
    const email = 'user.name+tag@x.com';
    getTokenStub.resolves(makeTokenRow(email));

    await processEmailVerificationJob(makeJob(), makeDeps());

    // sendMessage is suppressed — no text assertion needed
    expect(sendMessageStub.called).to.be.false;
    expect(markNotifiedStub.calledOnce).to.be.true;
  });

  // ── 7. Lock acquired → managerQueue.add called with correct args ──────────

  it('7. lock acquired → managerQueue.add called with jobId, text [email_verified], messageId 0, firstName empty', async () => {
    const job = makeJob({ jti: 'test-jti-uuid', userId: 11111111, chatId: 99887766 }); // userId ≠ chatId
    getTokenStub.resolves(makeTokenRow());
    const deps = makeDeps();

    await processEmailVerificationJob(job, deps);

    expect(acquireLockStub.calledOnce).to.be.true;
    expect(managerQueueAddStub.calledOnce).to.be.true;
    const [eventName, jobData, options] = managerQueueAddStub.firstCall.args;
    expect(eventName).to.equal('manager-message');
    expect(jobData.text).to.equal('[email_verified]');
    expect(jobData.messageId).to.equal(0);
    expect(jobData.firstName).to.equal('');
    expect(options.jobId).to.equal('email-verified-test-jti-uuid');
    // Regression guard: jobData must use userId (11111111), NOT chatId (99887766)
    expect(jobData.userId).to.equal(11111111);
    expect(jobData.conversationId).to.equal('manager:11111111');
  });

  // ── 8. acquireLock returns false → managerQueue.add NOT called ────────────

  it('8. acquireLock returns false → managerQueue.add NOT called, resolves without error', async () => {
    acquireLockStub.resolves(false);
    getTokenStub.resolves(makeTokenRow());

    await processEmailVerificationJob(makeJob(), makeDeps());

    expect(managerQueueAddStub.called).to.be.false;
  });

  // ── 9. acquireLock true but managerQueue.add throws → releaseLock called, no rethrow ──

  it('9. acquireLock true but managerQueue.add throws → releaseLock called, resolves without error', async () => {
    acquireLockStub.resolves(true);
    managerQueueAddStub.rejects(new Error('Queue unavailable'));
    getTokenStub.resolves(makeTokenRow());

    // Should NOT throw
    await processEmailVerificationJob(makeJob(), makeDeps());

    expect(releaseLockStub.calledOnce).to.be.true;
  });

  it('T3-01: resolves normally when managerQueue is omitted from WorkerDeps', async () => {
    getTokenStub.resolves(makeTokenRow());
    acquireLockStub.resolves(true);
    // deps WITHOUT managerQueue — falls through to module-level singleton stubbed via esmock
    const deps = {
      telegram: { sendMessage: sendMessageStub },
      agentService: {},
      managerBotToken: MANAGER_BOT_TOKEN,
      managerBotId: MANAGER_BOT_ID,
      baseUrl: 'https://example.com',
      botUsername: 'TestBot',
    };
    await processEmailVerificationJob(makeJob(), deps);
    // sendMessage is suppressed
    expect(sendMessageStub.called).to.be.false;
  });
});
