import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import express from 'express';
import request from 'supertest';
import type { AuthenticatedUser, ManagedBotRow } from '../../src/types/api.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const mockUser: AuthenticatedUser = { id: 7, telegramId: 55667788, firstName: 'Alice' };

const mockBotRow: ManagedBotRow = {
  id: 1,
  bot_id: 987654321,
  bot_username: 'myawesomebot',
  owner_telegram_id: 55667788,
  owner_user_id: 7,
  encrypted_token: Buffer.alloc(0),
  token_iv: Buffer.alloc(0),
  token_key_version: 1,
  status: 'ACTIVE',
  webhook_set: true,
  profile_set: true,
  commands_set: true,
  update_mode: 'webhook',
  polling_offset: 0,
  webhook_secret: null,
  webhook_secret_iv: null,
  webhook_secret_key_version: null,
  last_token_rotated: null,
  created_at: new Date('2024-01-15T10:00:00.000Z'),
  updated_at: new Date('2024-01-15T10:00:00.000Z'),
};

// ── helpers ───────────────────────────────────────────────────────────────────

/** Builds a supertest app with the botStatusRouter and a real error handler. */
function buildApp(botStatusRouter: any): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/bots', botStatusRouter);
  // Minimal error handler that mirrors the auth.test.ts pattern — surfaces statusCode.
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? err.status ?? 500).json({ ok: false, error: err.message });
  });
  return app;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('bot-status routes', () => {
  let botStatusRouter: any;
  let findBotStub: sinon.SinonStub;
  let verifyStub: sinon.SinonStub;
  let app: express.Express;
  let mod: any;
  let authMod: any;

  beforeEach(async () => {
    findBotStub = sinon.stub().resolves(mockBotRow);
    // verifyAccessToken is called synchronously inside requireAuth (auth.ts),
    // which is a transitive dependency of bot-status.ts.  Use a nested esmock
    // so the stub is injected all the way down the import chain.
    verifyStub = sinon.stub().returns(mockUser);

    authMod = await esmock('../../src/middleware/auth.ts', {
      '../../src/services/session.js': {
        verifyAccessToken: verifyStub,
      },
    });

    mod = await esmock('../../src/routes/bot-status.ts', {
      '../../src/db/queries/managed-bots.js': {
        findManagedBotByOwnerTelegramId: findBotStub,
      },
      '../../src/middleware/auth.js': authMod,
    });

    botStatusRouter = mod.botStatusRouter;
    app = buildApp(botStatusRouter);
  });

  afterEach(async () => {
    await esmock.purge(mod);
    await esmock.purge(authMod);
    sinon.restore();
  });

  describe('GET /api/bots/mine', () => {
    // ── 200: bot present ──────────────────────────────────────────────────────
    it('returns 200 with a fully-shaped bot object when the bot exists', async () => {
      const res = await request(app)
        .get('/api/bots/mine')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('ok', true);

      const bot = res.body.bot;
      expect(bot).to.not.be.null;
      expect(bot).to.have.property('botId', mockBotRow.bot_id);
      expect(bot).to.have.property('botUsername', mockBotRow.bot_username);
      expect(bot).to.have.property('status', mockBotRow.status);
      expect(bot).to.have.property('webhookSet', mockBotRow.webhook_set);
      expect(bot).to.have.property('profileSet', mockBotRow.profile_set);
      expect(bot).to.have.property('commandsSet', mockBotRow.commands_set);
      expect(bot).to.have.property('createdAt', mockBotRow.created_at.toISOString());
    });

    it('calls findManagedBotByOwnerTelegramId with the authenticated user telegramId', async () => {
      await request(app)
        .get('/api/bots/mine')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(findBotStub.calledOnce).to.be.true;
      expect(findBotStub.firstCall.args[0]).to.equal(mockUser.telegramId);
    });

    // ── 200: bot null ─────────────────────────────────────────────────────────
    it('returns 200 with bot: null when no bot is found for the user', async () => {
      findBotStub.resolves(null);

      const res = await request(app)
        .get('/api/bots/mine')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('ok', true);
      expect(res.body).to.have.property('bot', null);
    });

    it('returns 200 with bot: null when bot_username is null (no botUsername field in output)', async () => {
      const rowWithNullUsername: ManagedBotRow = { ...mockBotRow, bot_username: null };
      findBotStub.resolves(rowWithNullUsername);

      const res = await request(app)
        .get('/api/bots/mine')
        .set('Authorization', 'Bearer valid.jwt.token');

      expect(res.status).to.equal(200);
      // bot_username: null should yield no botUsername key (undefined → omitted by JSON.stringify)
      expect(res.body.bot).to.not.have.property('botUsername');
    });

    // ── 401: missing Authorization header ────────────────────────────────────
    it('returns 401 when the Authorization header is absent', async () => {
      const res = await request(app).get('/api/bots/mine');

      expect(res.status).to.equal(401);
    });

    it('returns 401 when the Authorization header does not start with Bearer', async () => {
      const res = await request(app)
        .get('/api/bots/mine')
        .set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(res.status).to.equal(401);
    });

    it('returns 401 when verifyAccessToken throws (expired / invalid token)', async () => {
      verifyStub.throws(new Error('jwt expired'));

      const res = await request(app)
        .get('/api/bots/mine')
        .set('Authorization', 'Bearer expired.jwt.token');

      expect(res.status).to.equal(401);
    });
  });
});
