import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import express from 'express';
import request from 'supertest';
import { issueRefreshToken, issueAccessToken } from '../../src/services/session.js';
import type { AuthenticatedUser } from '../../src/types/api.js';

const TEST_USER: AuthenticatedUser = {
  id: 'a0000000-0000-0000-0000-000000000001',
  telegramId: 99887766,
  firstName: 'Test',
  username: 'testuser',
};

const TEST_USER_ROW = {
  id: 'a0000000-0000-0000-0000-000000000001',
  telegram_id: 99887766,
  first_name: 'Test',
  last_name: null,
  username: 'testuser',
  photo_url: null,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('POST /api/auth/refresh', () => {
  let app: express.Express;
  let findUserByIdStub: sinon.SinonStub;
  let mod: any;

  beforeEach(async () => {
    findUserByIdStub = sinon.stub().resolves(TEST_USER_ROW);

    mod = await esmock('../../src/routes/auth.ts', {
      '../../src/db/queries/users.js': {
        upsertUser: sinon.stub(),
        findUserById: findUserByIdStub,
      },
    });

    app = express();
    app.use(express.json());
    app.use('/api/auth', mod.authRouter);
    // Minimal error handler matching the real one's shape
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode ?? err.status ?? 500).json({
        ok: false,
        error: err.message,
        code: err.code ?? 'INTERNAL_ERROR',
      });
    });
  });

  afterEach(async () => {
    await esmock.purge(mod);
    sinon.restore();
  });

  it('returns 200 with a new access token for a valid refresh token', async () => {
    const refreshToken = issueRefreshToken(TEST_USER);
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });

    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('ok', true);
    expect(res.body).to.have.property('accessToken').that.is.a('string').and.has.length.greaterThan(0);
    expect(findUserByIdStub.calledOnceWith('a0000000-0000-0000-0000-000000000001')).to.be.true;
  });

  it('returns 401 when refreshToken field is missing', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({});

    expect(res.status).to.equal(401);
    expect(res.body).to.have.property('ok', false);
  });

  it('returns 401 when refreshToken is an empty string', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: '' });

    expect(res.status).to.equal(401);
    expect(res.body).to.have.property('ok', false);
  });

  it('returns 401 when an access token is used as a refresh token (wrong type)', async () => {
    const accessToken = issueAccessToken(TEST_USER);
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: accessToken });

    expect(res.status).to.equal(401);
    expect(res.body).to.have.property('ok', false);
  });

  it('returns 401 when the token is completely invalid (garbage)', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'not.a.jwt' });

    expect(res.status).to.equal(401);
    expect(res.body).to.have.property('ok', false);
  });

  it('returns 401 when user is not found in the database', async () => {
    findUserByIdStub.resolves(null);
    const refreshToken = issueRefreshToken(TEST_USER);
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });

    expect(res.status).to.equal(401);
    expect(res.body).to.have.property('ok', false);
  });
});
