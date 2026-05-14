import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import express from 'express';
import request from 'supertest';

describe('verify-email route', () => {
  let verifyEmailRouter: any;
  let verifyVerificationTokenStub: sinon.SinonStub;
  let updateToolsetStateStub: sinon.SinonStub;
  let redisSetStub: sinon.SinonStub;
  let app: express.Express;

  const VALID_PAYLOAD = { email: 'test@example.com', botId: 'bot-42', userId: '99887766', jti: 'test-jti-uuid', exp: Math.floor(Date.now() / 1000) + 3600 };

  beforeEach(async () => {
    verifyVerificationTokenStub = sinon.stub();
    updateToolsetStateStub = sinon.stub().resolves(1);
    redisSetStub = sinon.stub().resolves('OK');

    const fakeRedis = { set: redisSetStub };

    const mod = await esmock('../../src/routes/verify-email.ts', {
      '../../src/services/email-verification.js': {
        verifyVerificationToken: verifyVerificationTokenStub,
      },
      '../../src/db/queries/conversations.js': {
        updateToolsetState: updateToolsetStateStub,
      },
      '../../src/services/redis.js': {
        getRedisClient: () => fakeRedis,
      },
    });

    verifyEmailRouter = mod.verifyEmailRouter;

    app = express();
    app.use(express.json());
    app.use('/verify-email', verifyEmailRouter);
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── Valid token ──────────────────────────────────────────────────────────

  describe('GET /verify-email?token=<valid>', () => {
    it('returns 200 with HTML success page', async () => {
      verifyVerificationTokenStub.returns(VALID_PAYLOAD);

      const res = await request(app).get('/verify-email?token=valid-jwt');

      expect(res.status).to.equal(200);
      expect(res.headers['content-type']).to.include('text/html');
      expect(res.text).to.include('Email verified');
    });

    it('calls updateToolsetState with email and email_verified: true', async () => {
      verifyVerificationTokenStub.returns(VALID_PAYLOAD);

      await request(app).get('/verify-email?token=valid-jwt');

      expect(updateToolsetStateStub.calledOnce).to.be.true;
      const [botId, telegramUserId, patch] = updateToolsetStateStub.firstCall.args;
      expect(botId).to.equal(VALID_PAYLOAD.botId);
      expect(telegramUserId).to.equal(Number(VALID_PAYLOAD.userId));
      expect(patch).to.deep.include({ email: VALID_PAYLOAD.email, email_verified: true });
    });
  });

  // ── Invalid / expired token ──────────────────────────────────────────────

  describe('GET /verify-email?token=<invalid>', () => {
    it('returns 400 with HTML error page when token verification throws', async () => {
      verifyVerificationTokenStub.throws(new Error('jwt expired'));

      const res = await request(app).get('/verify-email?token=bad-token');

      expect(res.status).to.equal(400);
      expect(res.text).to.include('failed');
    });

    it('returns 400 when token query param is missing', async () => {
      const res = await request(app).get('/verify-email');

      expect(res.status).to.equal(400);
      expect(res.text).to.include('failed');
    });
  });

  // ── DB error ─────────────────────────────────────────────────────────────

  describe('GET /verify-email — DB error', () => {
    it('returns 500 when updateToolsetState throws', async () => {
      verifyVerificationTokenStub.returns(VALID_PAYLOAD);
      updateToolsetStateStub.rejects(new Error('db connection lost'));

      const res = await request(app).get('/verify-email?token=valid-jwt');

      expect(res.status).to.equal(500);
    });
  });

  // ── non-numeric userId ────────────────────────────────────────────────────

  describe('GET /verify-email — non-numeric userId', () => {
    it('returns 400 when userId is non-numeric', async () => {
      verifyVerificationTokenStub.returns({ ...VALID_PAYLOAD, userId: 'not-a-number' });

      const res = await request(app).get('/verify-email?token=valid-jwt');

      expect(res.status).to.equal(400);
      expect(res.text).to.include('failed');
      expect(updateToolsetStateStub.called).to.be.false;
    });
  });

  // ── missing jti ───────────────────────────────────────────────────────────

  describe('GET /verify-email — missing jti', () => {
    it('returns 400 when verifyVerificationToken throws missing jti error', async () => {
      verifyVerificationTokenStub.throws(new Error('Invalid token: missing jti claim'));

      const res = await request(app).get('/verify-email?token=bad-token');

      expect(res.status).to.equal(400);
      expect(res.text).to.include('failed');
    });
  });

  // ── updateToolsetState returns 0 ─────────────────────────────────────────

  describe('GET /verify-email — graceful degradation', () => {
    it('returns 200 success when updateToolsetState returns 0 (no row found)', async () => {
      verifyVerificationTokenStub.returns(VALID_PAYLOAD);
      updateToolsetStateStub.resolves(0);

      const res = await request(app).get('/verify-email?token=valid-jwt');

      expect(res.status).to.equal(200);
      expect(res.text).to.include('Email verified');
    });
  });

  // ── JWT replay protection ─────────────────────────────────────────────────

  describe('GET /verify-email — JWT replay protection', () => {
    it('returns 200 on first request when Redis SET NX returns OK', async () => {
      verifyVerificationTokenStub.returns(VALID_PAYLOAD);
      redisSetStub.resolves('OK');

      const res = await request(app).get('/verify-email?token=valid-jwt');
      expect(res.status).to.equal(200);
    });

    it('returns 400 on second request when Redis SET NX returns null (already used)', async () => {
      verifyVerificationTokenStub.returns(VALID_PAYLOAD);
      redisSetStub.resolves(null); // Key already exists — token already used

      const res = await request(app).get('/verify-email?token=valid-jwt');
      expect(res.status).to.equal(400);
      expect(res.text).to.include('already used');
    });
  });
});
