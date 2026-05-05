import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import express from 'express';
import request from 'supertest';

describe('webhook routes', () => {
  let dispatchStub: sinon.SinonStub;
  let getBotWebhookSecretCachedStub: sinon.SinonStub;
  let app: express.Express;

  const setupApp = async (secretForBotId?: string | null) => {
    getBotWebhookSecretCachedStub = sinon.stub().resolves(secretForBotId ?? null);

    const { createWebhookRouter } = await esmock('../../src/routes/webhook.ts', {
      '../../src/middleware/webhook-secret.js': await esmock('../../src/middleware/webhook-secret.ts', {
        '../../src/services/token-store.js': {
          getBotWebhookSecretCached: getBotWebhookSecretCachedStub,
        },
      }),
    });

    dispatchStub = sinon.stub().resolves();
    const mockRegistry = { dispatch: dispatchStub };
    const a = express();
    a.use(express.json());
    a.use('/webhook', createWebhookRouter(mockRegistry as any));
    a.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message });
    });
    return a;
  };

  beforeEach(async () => {
    app = await setupApp(null); // default: DB returns null → fallback to env var
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  describe('POST /webhook/telegram (manager)', () => {
    it('returns 200 for correct webhook secret', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .set('x-telegram-bot-api-secret-token', 'test-webhook-secret-32-chars-long-ok')
        .send({ update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 1 } });
      expect(res.status).to.equal(200);
    });

    it('calls registry.dispatch with manager and the update', async () => {
      const update = { update_id: 42, message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 1 } };
      await request(app)
        .post('/webhook/telegram')
        .set('x-telegram-bot-api-secret-token', 'test-webhook-secret-32-chars-long-ok')
        .send(update);
      expect(dispatchStub.calledWith('manager')).to.be.true;
      expect(dispatchStub.firstCall.args[1]).to.deep.equal(update);
    });

    it('returns 403 for wrong webhook secret', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .set('x-telegram-bot-api-secret-token', 'wrong-secret')
        .send({ update_id: 1 });
      expect(res.status).to.equal(403);
    });

    it('returns 403 when webhook secret header is missing', async () => {
      const res = await request(app)
        .post('/webhook/telegram')
        .send({ update_id: 1 });
      expect(res.status).to.equal(403);
    });
  });

  describe('POST /webhook/bot/:botId (child)', () => {
    it('returns 200 for correct child secret', async () => {
      const res = await request(app)
        .post('/webhook/bot/123')
        .set('x-telegram-bot-api-secret-token', 'child-webhook-secret-32-chars-ok-x')
        .send({ update_id: 1 });
      expect(res.status).to.equal(200);
    });

    it('calls registry.dispatch with the numeric botId', async () => {
      await request(app)
        .post('/webhook/bot/456')
        .set('x-telegram-bot-api-secret-token', 'child-webhook-secret-32-chars-ok-x')
        .send({ update_id: 99 });
      expect(dispatchStub.calledWith(456)).to.be.true;
    });

    it('returns 403 for wrong child secret', async () => {
      const res = await request(app)
        .post('/webhook/bot/123')
        .set('x-telegram-bot-api-secret-token', 'wrong-secret')
        .send({ update_id: 1 });
      expect(res.status).to.equal(403);
    });

    it('returns 400 for non-numeric botId', async () => {
      const res = await request(app)
        .post('/webhook/bot/notanumber')
        .set('x-telegram-bot-api-secret-token', 'child-webhook-secret-32-chars-ok-x')
        .send({ update_id: 1 });
      expect(res.status).to.equal(400);
    });

    it('M-01: returns 200 for correct per-bot secret from DB', async () => {
      const perBotSecret = 'a'.repeat(64);
      const appWithSecret = await setupApp(perBotSecret);
      const res = await request(appWithSecret)
        .post('/webhook/bot/123')
        .set('x-telegram-bot-api-secret-token', perBotSecret)
        .send({ update_id: 1 });
      expect(res.status).to.equal(200);
    });

    it('M-01: returns 403 when per-bot secret is set but wrong secret is provided', async () => {
      const perBotSecret = 'a'.repeat(64);
      const appWithSecret = await setupApp(perBotSecret);
      const res = await request(appWithSecret)
        .post('/webhook/bot/123')
        .set('x-telegram-bot-api-secret-token', 'wrong-secret-not-matching-per-bot')
        .send({ update_id: 1 });
      expect(res.status).to.equal(403);
    });
  });
});
