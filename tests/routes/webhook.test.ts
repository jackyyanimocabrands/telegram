import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import express from 'express';
import request from 'supertest';
import { createWebhookRouter } from '../../src/routes/webhook.js';
import { pool } from '../../src/db/client.js';
import { webhookSecretCache } from '../../src/services/token-store.js';

describe('webhook routes', () => {
  let dispatchStub: sinon.SinonStub;
  let app: express.Express;
  let queryStub: sinon.SinonStub;

  beforeEach(() => {
    // M-01: Clear per-bot webhook secret cache so tests are independent
    webhookSecretCache.clear();
    // M-01: verifyChildWebhookSecret now does a DB lookup for per-bot secret.
    // Stub pool.query to return null webhook_secret so the fallback env var is used.
    queryStub = sinon.stub(pool, 'query').resolves({ rows: [] });

    dispatchStub = sinon.stub().resolves();
    const mockRegistry = { dispatch: dispatchStub };
    app = express();
    app.use(express.json());
    app.use('/webhook', createWebhookRouter(mockRegistry as any));
    // Error handler
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message });
    });
  });

  afterEach(() => sinon.restore());

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
      // dispatch is fire-and-forget after 200; give it a tick
      await new Promise(r => setTimeout(r, 10));
      expect(dispatchStub.calledWith('manager')).to.be.true;
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
      const update = { update_id: 7 };
      await request(app)
        .post('/webhook/bot/123')
        .set('x-telegram-bot-api-secret-token', 'child-webhook-secret-32-chars-ok-x')
        .send(update);
      await new Promise(r => setTimeout(r, 10));
      expect(dispatchStub.calledWith(123)).to.be.true;
    });

    it('returns 403 for wrong child secret', async () => {
      const res = await request(app)
        .post('/webhook/bot/123')
        .set('x-telegram-bot-api-secret-token', 'wrong')
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
      queryStub.resolves({ rows: [{ webhook_secret: perBotSecret }] });
      const res = await request(app)
        .post('/webhook/bot/123')
        .set('x-telegram-bot-api-secret-token', perBotSecret)
        .send({ update_id: 1 });
      expect(res.status).to.equal(200);
    });

    it('M-01: returns 403 when per-bot secret is set but wrong secret is provided', async () => {
      const perBotSecret = 'a'.repeat(64);
      queryStub.resolves({ rows: [{ webhook_secret: perBotSecret }] });
      const res = await request(app)
        .post('/webhook/bot/123')
        .set('x-telegram-bot-api-secret-token', 'wrong-secret-not-matching-per-bot')
        .send({ update_id: 1 });
      expect(res.status).to.equal(403);
    });
  });
});

