import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

const BOT_TOKEN = '123456:ABC-DEF_test_token';

function makeValidBody() {
  const auth_date = String(Math.floor(Date.now() / 1000));
  const base = { id: '99887766', first_name: 'Test', username: 'testuser', auth_date };
  const dataCheckString = Object.keys(base).sort().map(k => `${k}=${(base as any)[k]}`).join('\n');
  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return { ...base, hash };
}

describe('auth routes', () => {
  let authRouter: any;
  let upsertUserStub: sinon.SinonStub;
  let app: express.Express;

  beforeEach(async () => {
    upsertUserStub = sinon.stub().resolves({
      id: 'a0000000-0000-0000-0000-000000000001',
      telegram_id: 99887766,
      first_name: 'Test',
      last_name: null,
      username: 'testuser',
      photo_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const module = await esmock('../../src/routes/auth.ts', {
      '../../src/db/queries/users.js': { upsertUser: upsertUserStub },
    });
    authRouter = module.authRouter;

    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    // Simple error handler
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message });
    });
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  describe('GET /api/auth/config', () => {
    it('returns 200 with botUsername', async () => {
      const res = await request(app).get('/api/auth/config');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('botUsername', 'TestManagerBot');
    });
  });

  describe('POST /api/auth/telegram', () => {
     it('returns 200 with user, accessToken, refreshToken, and deepLink on valid auth', async () => {
      const res = await request(app)
        .post('/api/auth/telegram')
        .send(makeValidBody());
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('ok', true);
      expect(res.body).to.have.property('accessToken').that.is.a('string');
      expect(res.body).to.have.property('refreshToken').that.is.a('string');
      expect(res.body).to.have.property('deepLink').that.is.a('string');
      expect(res.body.user).to.have.property('telegramId', 99887766);
    });

    it('returns 422 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/auth/telegram')
        .send({ id: '123' }); // missing hash, auth_date, first_name
      expect(res.status).to.equal(422);
    });

    it('returns 401 when hash verification fails', async () => {
      const body = makeValidBody();
      body.hash = 'a'.repeat(64); // wrong hash
      const res = await request(app)
        .post('/api/auth/telegram')
        .send(body);
      expect(res.status).to.equal(401);
    });

    it('calls upsertUser with correct telegramId', async () => {
      await request(app).post('/api/auth/telegram').send(makeValidBody());
      expect(upsertUserStub.calledOnce).to.be.true;
      expect(upsertUserStub.firstCall.args[0].telegramId).to.equal(99887766);
    });
  });
});
