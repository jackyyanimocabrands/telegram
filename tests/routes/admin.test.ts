import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import express from 'express';
import request from 'supertest';

const TEST_ADMIN_KEY = 'test-admin-key-for-testing-purposes-only-32chars';
const AUTH_HEADER = `Bearer ${TEST_ADMIN_KEY}`;

describe('admin routes', () => {
  let getTokenUsageSummaryStub: sinon.SinonStub;
  let getConversationTokenUsageStub: sinon.SinonStub;
  let getBotTokenUsageStub: sinon.SinonStub;
  let app: express.Express;

  const setupApp = async () => {
    getTokenUsageSummaryStub = sinon.stub().resolves([]);
    getConversationTokenUsageStub = sinon.stub().resolves([]);
    getBotTokenUsageStub = sinon.stub().resolves([]);

    const { adminRouter } = await esmock('../../src/routes/admin.ts', {
      '../../src/config/env.js': {
        env: { ADMIN_API_KEY: TEST_ADMIN_KEY },
      },
      '../../src/middleware/admin-auth.js': await esmock('../../src/middleware/admin-auth.ts', {
        '../../src/config/env.js': {
          env: { ADMIN_API_KEY: TEST_ADMIN_KEY },
        },
      }),
      '../../src/db/queries/token-usage.js': {
        getTokenUsageSummary: getTokenUsageSummaryStub,
        getConversationTokenUsage: getConversationTokenUsageStub,
        getBotTokenUsage: getBotTokenUsageStub,
      },
      '../../src/db/client.js': {
        pool: {},
      },
      '../../src/utils/logger.js': {
        logger: { error: sinon.stub(), debug: sinon.stub(), warn: sinon.stub(), info: sinon.stub() },
      },
    });

    const a = express();
    a.use(express.json());
    a.use('/admin', adminRouter);
    a.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode ?? err.status ?? 500).json({ error: err.message });
    });
    return a;
  };

  beforeEach(async () => {
    app = await setupApp();
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── Auth guard ─────────────────────────────────────────────────────────────

  describe('auth guard — GET /admin/token-usage/summary', () => {
    it('returns 401 when no Authorization header', async () => {
      const res = await request(app).get('/admin/token-usage/summary');
      expect(res.status).to.equal(401);
    });

    it('returns 401 for wrong token', async () => {
      const res = await request(app)
        .get('/admin/token-usage/summary')
        .set('Authorization', 'Bearer wrong-token-value-here');
      expect(res.status).to.equal(401);
    });

    it('passes through with correct token', async () => {
      const res = await request(app)
        .get('/admin/token-usage/summary')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).to.equal(200);
    });
  });

  describe('auth guard — GET /admin/token-usage/conversation/:botId/:userId', () => {
    it('returns 401 when no Authorization header', async () => {
      const res = await request(app).get('/admin/token-usage/conversation/bot-1/42');
      expect(res.status).to.equal(401);
    });

    it('returns 401 for wrong token', async () => {
      const res = await request(app)
        .get('/admin/token-usage/conversation/bot-1/42')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).to.equal(401);
    });
  });

  describe('auth guard — GET /admin/token-usage/bot/:botId', () => {
    it('returns 401 when no Authorization header', async () => {
      const res = await request(app).get('/admin/token-usage/bot/bot-1');
      expect(res.status).to.equal(401);
    });

    it('returns 401 for wrong token', async () => {
      const res = await request(app)
        .get('/admin/token-usage/bot/bot-1')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).to.equal(401);
    });
  });

  // ── GET /admin/token-usage/summary ────────────────────────────────────────

  describe('GET /admin/token-usage/summary', () => {
    it('forwards provider query param to getTokenUsageSummary', async () => {
      getTokenUsageSummaryStub.resolves([]);

      await request(app)
        .get('/admin/token-usage/summary?provider=openai')
        .set('Authorization', AUTH_HEADER);

      expect(getTokenUsageSummaryStub.calledOnce).to.be.true;
      const [, filters] = getTokenUsageSummaryStub.firstCall.args as [unknown, { provider?: string }];
      expect(filters.provider).to.equal('openai');
    });

    it('returns 200 with rows from getTokenUsageSummary', async () => {
      const mockRows = [{ provider: 'openai', model: 'gpt-4o', usage_type: 'chat', call_count: '5' }];
      getTokenUsageSummaryStub.resolves(mockRows);

      const res = await request(app)
        .get('/admin/token-usage/summary')
        .set('Authorization', AUTH_HEADER);

      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal(mockRows);
    });

    it('returns 400 for invalid "from" date', async () => {
      const res = await request(app)
        .get('/admin/token-usage/summary?from=not-a-date')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).to.equal(400);
    });

    it('returns 400 for invalid "to" date', async () => {
      const res = await request(app)
        .get('/admin/token-usage/summary?to=not-a-date')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).to.equal(400);
    });

    it('applies default 90-day window when no date filter provided', async () => {
      getTokenUsageSummaryStub.resolves([]);

      const before = Date.now();
      await request(app)
        .get('/admin/token-usage/summary')
        .set('Authorization', AUTH_HEADER);
      const after = Date.now();

      expect(getTokenUsageSummaryStub.calledOnce).to.be.true;
      const [, filters] = getTokenUsageSummaryStub.firstCall.args as [unknown, { from?: Date }];
      expect(filters.from).to.be.instanceOf(Date);

      const expectedFrom = before - 90 * 24 * 60 * 60 * 1000;
      const actualFrom = filters.from!.getTime();
      // Allow 1 second tolerance
      expect(actualFrom).to.be.within(expectedFrom - 1000, after - 90 * 24 * 60 * 60 * 1000 + 1000);
    });
  });

  // ── GET /admin/token-usage/conversation/:botId/:userId ────────────────────

  describe('GET /admin/token-usage/conversation/:botId/:userId', () => {
    it('returns 400 for non-numeric userId', async () => {
      const res = await request(app)
        .get('/admin/token-usage/conversation/bot-1/notanumber')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).to.equal(400);
    });

    it('returns 200 for valid botId and numeric userId', async () => {
      const mockRows = [{ id: 'uuid-1', bot_id: 'bot-1', telegram_user_id: '42' }];
      getConversationTokenUsageStub.resolves(mockRows);

      const res = await request(app)
        .get('/admin/token-usage/conversation/bot-1/42')
        .set('Authorization', AUTH_HEADER);

      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal(mockRows);
    });

    it('passes userId as a number to the query function', async () => {
      await request(app)
        .get('/admin/token-usage/conversation/bot-1/42')
        .set('Authorization', AUTH_HEADER);

      const [, botId, userId] = getConversationTokenUsageStub.firstCall.args as [unknown, string, number];
      expect(botId).to.equal('bot-1');
      expect(userId).to.equal(42);
    });

    it('returns 400 for invalid "from" date', async () => {
      const res = await request(app)
        .get('/admin/token-usage/conversation/bot-1/42?from=not-a-date')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).to.equal(400);
    });
  });

  // ── GET /admin/token-usage/bot/:botId ─────────────────────────────────────

  describe('GET /admin/token-usage/bot/:botId', () => {
    it('returns 200 for valid botId', async () => {
      const mockRows = [{ id: 'uuid-2', bot_id: 'bot-1' }];
      getBotTokenUsageStub.resolves(mockRows);

      const res = await request(app)
        .get('/admin/token-usage/bot/bot-1')
        .set('Authorization', AUTH_HEADER);

      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal(mockRows);
    });

    it('passes limit=500 through to the query', async () => {
      await request(app)
        .get('/admin/token-usage/bot/bot-1?limit=500')
        .set('Authorization', AUTH_HEADER);

      expect(getBotTokenUsageStub.calledOnce).to.be.true;
      const [, , filters] = getBotTokenUsageStub.firstCall.args as [unknown, string, { limit?: number }];
      expect(filters.limit).to.equal(500);
    });

    it('passes undefined limit when limit=0 (invalid)', async () => {
      await request(app)
        .get('/admin/token-usage/bot/bot-1?limit=0')
        .set('Authorization', AUTH_HEADER);

      const [, , filters] = getBotTokenUsageStub.firstCall.args as [unknown, string, { limit?: number }];
      expect(filters.limit).to.be.undefined;
    });

    it('passes undefined limit when limit=-1 (invalid)', async () => {
      await request(app)
        .get('/admin/token-usage/bot/bot-1?limit=-1')
        .set('Authorization', AUTH_HEADER);

      const [, , filters] = getBotTokenUsageStub.firstCall.args as [unknown, string, { limit?: number }];
      expect(filters.limit).to.be.undefined;
    });

    it('passes undefined limit when limit=abc (non-numeric)', async () => {
      await request(app)
        .get('/admin/token-usage/bot/bot-1?limit=abc')
        .set('Authorization', AUTH_HEADER);

      const [, , filters] = getBotTokenUsageStub.firstCall.args as [unknown, string, { limit?: number }];
      expect(filters.limit).to.be.undefined;
    });

    it('caps limit to 5000 when limit=6000', async () => {
      await request(app)
        .get('/admin/token-usage/bot/bot-1?limit=6000')
        .set('Authorization', AUTH_HEADER);

      const [, , filters] = getBotTokenUsageStub.firstCall.args as [unknown, string, { limit?: number }];
      expect(filters.limit).to.equal(5000);
    });

    it('returns 400 for invalid "from" date', async () => {
      const res = await request(app)
        .get('/admin/token-usage/bot/bot-1?from=bad-date')
        .set('Authorization', AUTH_HEADER);
      expect(res.status).to.equal(400);
    });
  });
});
