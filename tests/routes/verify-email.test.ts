import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import express from 'express';
import request from 'supertest';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTokenRow(overrides: Partial<{
  jti: string;
  email: string;
  bot_id: string;
  user_id: number;
  status: 'pending' | 'verified' | 'notified';
  expires_at: Date;
}> = {}) {
  return {
    jti: 'test-jti-uuid',
    email: 'test@example.com',
    bot_id: 'bot-42',
    user_id: 99887766,
    status: 'pending' as const,
    expires_at: new Date(Date.now() + 3600_000),
    verified_at: null,
    notified_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('verify-email route', () => {
  // stubs
  let verifyVerificationTokenStub: sinon.SinonStub;
  let getTokenStub: sinon.SinonStub;
  let markVerifiedAtomicStub: sinon.SinonStub;
  let extendExpiryStub: sinon.SinonStub;
  let updateToolsetStateStub: sinon.SinonStub;
  let queueAddStub: sinon.SinonStub;
  let getNowStub: sinon.SinonStub;

  let createVerifyEmailRouter: any;
  let app: express.Express;

  // Fixed "now" for deterministic TTL comparisons
  const NOW = new Date('2024-01-15T12:00:00.000Z');
  const FUTURE_EXPIRES = new Date(NOW.getTime() + 3600_000); // 1 hour from now

  const VALID_PAYLOAD = {
    email: 'test@example.com',
    botId: 'bot-42',
    userId: '99887766',
    jti: 'test-jti-uuid',
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
  };

  beforeEach(async () => {
    verifyVerificationTokenStub = sinon.stub().returns(VALID_PAYLOAD);
    getTokenStub = sinon.stub().resolves(makeTokenRow());
    markVerifiedAtomicStub = sinon.stub().resolves(makeTokenRow({ status: 'verified' }));
    extendExpiryStub = sinon.stub().resolves();
    updateToolsetStateStub = sinon.stub().resolves(1);
    queueAddStub = sinon.stub().resolves();
    getNowStub = sinon.stub().returns(NOW);

    const mod = await esmock('../../src/routes/verify-email.ts', {
      '../../src/services/email-verification.js': {
        verifyVerificationToken: verifyVerificationTokenStub,
      },
      '../../src/db/queries/email-verification-tokens.js': {
        getToken: getTokenStub,
        markVerifiedAtomic: markVerifiedAtomicStub,
        extendExpiry: extendExpiryStub,
      },
      '../../src/db/queries/conversations.js': {
        updateToolsetState: updateToolsetStateStub,
      },
      '../../src/queues/email-verification-queue.js': {
        getEmailVerificationQueue: () => ({ add: queueAddStub }),
      },
    });

    createVerifyEmailRouter = mod.createVerifyEmailRouter;

    // Build an Express app using injectable deps so stubs wire in cleanly
    app = express();
    app.use(express.json());
    app.use(
      '/verify-email',
      createVerifyEmailRouter({
        getNow: getNowStub,
        queue: { add: queueAddStub },
        getToken: getTokenStub,
        markVerifiedAtomic: markVerifiedAtomicStub,
        extendExpiry: extendExpiryStub,
        updateToolsetState: updateToolsetStateStub,
        verifyVerificationToken: verifyVerificationTokenStub,
        renewThresholdSecs: 300,
        ttlSecs: 1800,
      }),
    );
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── 1. Missing token query param → 400 ────────────────────────────────────

  it('1. returns 400 when token query param is missing', async () => {
    const res = await request(app).get('/verify-email');
    expect(res.status).to.equal(400);
    expect(res.text).to.include('failed');
    expect(verifyVerificationTokenStub.called).to.be.false;
  });

  // ── 2. Invalid JWT → 400 ─────────────────────────────────────────────────

  it('2. returns 400 when verifyVerificationToken throws (invalid JWT)', async () => {
    verifyVerificationTokenStub.throws(new Error('jwt expired'));
    const res = await request(app).get('/verify-email?token=bad-token');
    expect(res.status).to.equal(400);
    expect(res.text).to.include('failed');
    expect(getTokenStub.called).to.be.false;
  });

  // ── 3. getToken returns null → 400 ───────────────────────────────────────

  it('3. returns 400 when getToken returns null (token not in DB)', async () => {
    getTokenStub.resolves(null);
    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(400);
    expect(res.text).to.include('failed');
  });

  // ── 4. Token expired (expires_at in past) → 400 ───────────────────────────

  it('4. returns 400 when token expires_at is in the past', async () => {
    getTokenStub.resolves(makeTokenRow({ expires_at: new Date(NOW.getTime() - 1) }));
    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(400);
    expect(res.text).to.include('failed');
  });

  // ── 5. Status 'notified' → 400 ALREADY_USED_HTML ─────────────────────────

  it("5. returns 400 ALREADY_USED when status is 'notified'", async () => {
    getTokenStub.resolves(makeTokenRow({ status: 'notified', expires_at: FUTURE_EXPIRES }));
    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(400);
    expect(res.text).to.include('already used');
  });

  // ── 6. JWT claim mismatch → 400 ───────────────────────────────────────────

  it('6. returns 400 when JWT claims do not match DB row (email mismatch)', async () => {
    getTokenStub.resolves(makeTokenRow({ email: 'other@example.com', expires_at: FUTURE_EXPIRES }));
    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(400);
    expect(res.text).to.include('failed');
  });

  it('6b. returns 400 when JWT claims do not match DB row (botId mismatch)', async () => {
    getTokenStub.resolves(makeTokenRow({ bot_id: 'other-bot', expires_at: FUTURE_EXPIRES }));
    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(400);
    expect(res.text).to.include('failed');
  });

  // ── 7. Happy path first-click (status 'pending', markVerifiedAtomic succeeds) ───

  it('7. happy path: calls updateToolsetState, queue.add, returns 200 SUCCESS_HTML', async () => {
    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(200);
    expect(res.text).to.include('Email verified');

    expect(markVerifiedAtomicStub.calledOnceWith(VALID_PAYLOAD.jti)).to.be.true;
    expect(updateToolsetStateStub.calledOnce).to.be.true;
    const [botId, uid, patch] = updateToolsetStateStub.firstCall.args;
    expect(botId).to.equal(VALID_PAYLOAD.botId);
    expect(uid).to.equal(Number(VALID_PAYLOAD.userId));
    expect(patch).to.deep.include({ email: VALID_PAYLOAD.email, email_verified: true });

    expect(queueAddStub.calledOnce).to.be.true;
  });

  // ── 8. updateToolsetState returns 0 → 200 NO_CONVERSATION_HTML, queue.add NOT called ──

  it('8. returns 200 NO_CONVERSATION_HTML when updateToolsetState returns 0', async () => {
    updateToolsetStateStub.resolves(0);
    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(200);
    expect(res.text).to.include('send a message to the bot');
    expect(queueAddStub.called).to.be.false;
  });

  // ── 9. markVerifiedAtomic returns null (race) → 200 SUCCESS_HTML ──────────

  it('9. returns 200 SUCCESS_HTML when markVerifiedAtomic returns null (race)', async () => {
    markVerifiedAtomicStub.resolves(null);
    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(200);
    expect(res.text).to.include('Email verified');
    // No further DB calls after race
    expect(updateToolsetStateStub.called).to.be.false;
    expect(queueAddStub.called).to.be.false;
  });

  // ── 10. Re-click path (status 'verified', TTL > threshold): extendExpiry with ORIGINAL expires_at ──

  it('10. re-click with TTL > threshold: extendExpiry called with original expires_at', async () => {
    const renewThresholdSecs = 300;
    // TTL remaining = 1 hour >> 300s threshold → keep original
    const originalExpiresAt = new Date(NOW.getTime() + 3600_000);
    getTokenStub.resolves(makeTokenRow({ status: 'verified', expires_at: originalExpiresAt }));

    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(200);
    expect(res.text).to.include('Email verified');

    expect(extendExpiryStub.calledOnce).to.be.true;
    expect(extendExpiryStub.firstCall.args[1]).to.deep.equal(originalExpiresAt);
    expect(updateToolsetStateStub.calledOnce).to.be.true;
    expect(queueAddStub.called).to.be.false;
  });

  // ── 11. Re-click path (status 'verified', TTL < threshold): extendExpiry with extended expires_at ──

  it('11. re-click with TTL < threshold: extendExpiry called with extended expires_at (now + ttlSecs)', async () => {
    const ttlSecs = 1800;
    // TTL remaining = 60s < 300s threshold → extend
    const nearlyExpiredAt = new Date(NOW.getTime() + 60_000);
    getTokenStub.resolves(makeTokenRow({ status: 'verified', expires_at: nearlyExpiredAt }));

    const res = await request(app).get('/verify-email?token=valid-jwt');
    expect(res.status).to.equal(200);
    expect(res.text).to.include('Email verified');

    expect(extendExpiryStub.calledOnce).to.be.true;
    const extendedAt: Date = extendExpiryStub.firstCall.args[1];
    const expectedAt = new Date(NOW.getTime() + ttlSecs * 1000);
    expect(extendedAt).to.deep.equal(expectedAt);
  });
});
