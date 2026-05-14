import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { pool } from '../../../src/db/client.js';
import {
  insertTokenUsage,
  getTokenUsageSummary,
  getConversationTokenUsage,
  getBotTokenUsage,
} from '../../../src/db/queries/token-usage.js';

describe('token-usage queries', () => {
  let queryStub: sinon.SinonStub;

  beforeEach(() => {
    queryStub = sinon.stub(pool, 'query');
    queryStub.resolves({ rows: [] });
  });

  afterEach(() => sinon.restore());

  // ── insertTokenUsage ───────────────────────────────────────────────────────

  describe('insertTokenUsage', () => {
    it('calls pool.query with SQL containing INSERT INTO token_usage', async () => {
      await insertTokenUsage(pool, {
        botId: 'bot-1',
        telegramUserId: 42,
        provider: 'openai',
        model: 'gpt-4o',
        usageType: 'chat',
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
      });
      expect(queryStub.calledOnce).to.be.true;
      const [sql] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('INSERT INTO token_usage');
    });

    it('passes all 8 params in correct order', async () => {
      await insertTokenUsage(pool, {
        botId: 'bot-1',
        telegramUserId: 42,
        provider: 'openai',
        model: 'gpt-4o',
        usageType: 'chat',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      });
      const [, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(params).to.deep.equal(['bot-1', 42, 'openai', 'gpt-4o', 'chat', 10, 20, 30]);
    });

    it('correctly passes usageType "summarization"', async () => {
      await insertTokenUsage(pool, {
        botId: 'bot-2',
        telegramUserId: 99,
        provider: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        usageType: 'summarization',
        inputTokens: 50,
        outputTokens: 150,
        totalTokens: 200,
      });
      const [, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(params[4]).to.equal('summarization');
    });
  });

  // ── getTokenUsageSummary ───────────────────────────────────────────────────

  describe('getTokenUsageSummary', () => {
    it('uses no WHERE clause and no extra params when no filters provided', async () => {
      await getTokenUsageSummary(pool, {});
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.not.include('WHERE');
      expect(params).to.have.length(0);
    });

    it('adds WHERE provider = $1 when provider filter only is provided', async () => {
      await getTokenUsageSummary(pool, { provider: 'openai' });
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('WHERE');
      expect(sql).to.include('provider = $1');
      expect(params[0]).to.equal('openai');
    });

    it('includes both from and to params when both date filters provided', async () => {
      const from = new Date('2025-01-01');
      const to = new Date('2025-03-31');
      await getTokenUsageSummary(pool, { from, to });
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('WHERE');
      expect(sql).to.include('created_at >=');
      expect(sql).to.include('created_at <=');
      expect(params).to.include(from);
      expect(params).to.include(to);
    });

    it('SQL contains GROUP BY provider, model, usage_type', async () => {
      await getTokenUsageSummary(pool, {});
      const [sql] = queryStub.firstCall.args as [string];
      expect(sql).to.include('GROUP BY provider, model, usage_type');
    });

    it('SQL contains SUM(input_tokens), SUM(output_tokens), SUM(total_tokens) as sum_total_tokens', async () => {
      await getTokenUsageSummary(pool, {});
      const [sql] = queryStub.firstCall.args as [string];
      expect(sql).to.include('SUM(input_tokens)');
      expect(sql).to.include('SUM(output_tokens)');
      expect(sql).to.include('SUM(total_tokens)');
      expect(sql).to.include('sum_total_tokens');
    });
  });

  // ── getConversationTokenUsage ──────────────────────────────────────────────

  describe('getConversationTokenUsage', () => {
    it('uses WHERE bot_id = $1 AND telegram_user_id = $2', async () => {
      await getConversationTokenUsage(pool, 'bot-1', 42, {});
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('bot_id = $1');
      expect(sql).to.include('telegram_user_id = $2');
      expect(params[0]).to.equal('bot-1');
      expect(params[1]).to.equal(42);
    });

    it('adds from filter as extra param when from is provided', async () => {
      const from = new Date('2025-01-01');
      await getConversationTokenUsage(pool, 'bot-1', 42, { from });
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('created_at >=');
      expect(params).to.include(from);
    });

    it('appends LIMIT with value 500 when limit: 500 is specified', async () => {
      await getConversationTokenUsage(pool, 'bot-1', 42, { limit: 500 });
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('LIMIT');
      const limitParam = params[params.length - 1];
      expect(limitParam).to.equal(500);
    });

    it('defaults to LIMIT 1000 when no limit specified', async () => {
      await getConversationTokenUsage(pool, 'bot-1', 42, {});
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('LIMIT');
      const limitParam = params[params.length - 1];
      expect(limitParam).to.equal(1000);
    });

    it('SQL contains ORDER BY created_at DESC', async () => {
      await getConversationTokenUsage(pool, 'bot-1', 42, {});
      const [sql] = queryStub.firstCall.args as [string];
      expect(sql).to.include('ORDER BY created_at DESC');
    });
  });

  // ── getBotTokenUsage ───────────────────────────────────────────────────────

  describe('getBotTokenUsage', () => {
    it('uses WHERE bot_id = $1 for the given botId', async () => {
      await getBotTokenUsage(pool, 'bot-99', {});
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('bot_id = $1');
      expect(params[0]).to.equal('bot-99');
    });

    it('defaults to LIMIT 1000 when no limit is specified', async () => {
      await getBotTokenUsage(pool, 'bot-99', {});
      const [, params] = queryStub.firstCall.args as [string, unknown[]];
      const limitParam = params[params.length - 1];
      expect(limitParam).to.equal(1000);
    });

    it('respects a custom limit of 250', async () => {
      await getBotTokenUsage(pool, 'bot-99', { limit: 250 });
      const [, params] = queryStub.firstCall.args as [string, unknown[]];
      const limitParam = params[params.length - 1];
      expect(limitParam).to.equal(250);
    });
  });
});
