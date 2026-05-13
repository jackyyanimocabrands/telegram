import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { pool } from '../../../src/db/client.js';
import {
  getConversation,
  upsertConversation,
  updateConversationMessages,
  updateConversationProvider,
  clearConversation,
  setConversationSystemPrompt,
} from '../../../src/db/queries/conversations.js';

// Minimal fixture — mirrors the full ConversationRow shape
const makeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'a0000000-0000-0000-0000-000000000001',
  bot_id: 'bot123',
  telegram_user_id: 99,
  llm_provider: 'openai',
  llm_model: 'gpt-4o',
  summarization_provider: 'openai',
  summarization_model: 'gpt-4o-mini',
  messages: [],
  summary: null,
  system_prompt: null,
  created_at: new Date('2024-01-01T00:00:00Z'),
  updated_at: new Date('2024-01-01T00:00:00Z'),
  ...overrides,
});

describe('conversations queries', () => {
  let queryStub: sinon.SinonStub;

  beforeEach(() => {
    queryStub = sinon.stub(pool, 'query');
  });

  afterEach(() => sinon.restore());

  // ── getConversation ──────────────────────────────────────────────────────

  describe('getConversation', () => {
    it('returns null when query returns 0 rows', async () => {
      queryStub.resolves({ rows: [] });
      const result = await getConversation('bot123', 99);
      expect(result).to.be.null;
    });

    it('returns the parsed ConversationRow when a row is found', async () => {
      const row = makeRow({ messages: [{ role: 'user', content: 'hello' }] });
      queryStub.resolves({ rows: [row] });
      const result = await getConversation('bot123', 99);
      expect(result).to.deep.equal(row);
    });

    it('calls pool.query with the correct botId and telegramUserId parameters', async () => {
      queryStub.resolves({ rows: [] });
      await getConversation('bot123', 99);
      expect(queryStub.calledOnce).to.be.true;
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('conversations');
      expect(params).to.include('bot123');
      expect(params).to.include(99);
    });

    // T1-02 — cross-bot isolation: querying bot-1 when only bot-2 row exists returns null
    it('T1-02: returns null and passes bot-1/42 params when row belongs to bot-2 (cross-bot isolation)', async () => {
      // DB returns 0 rows — simulates WHERE bot_id='bot-1' not matching the bot-2 row
      queryStub.resolves({ rows: [] });
      const result = await getConversation('bot-1', 42);
      expect(result).to.be.null;

      const [, params] = queryStub.firstCall.args as [string, unknown[]];
      // Both bot_id AND telegram_user_id must be passed as separate params
      expect(params).to.include('bot-1');
      expect(params).to.include(42);
      expect(params).to.have.length.at.least(2);
    });

    // T1-03 — cross-user isolation: querying user 42 when only user 99 row exists returns null
    it('T1-03: returns null and passes bot-1/42 params when row belongs to user-99 (cross-user isolation)', async () => {
      // DB returns 0 rows — simulates WHERE telegram_user_id=42 not matching the user-99 row
      queryStub.resolves({ rows: [] });
      const result = await getConversation('bot-1', 42);
      expect(result).to.be.null;

      const [, params] = queryStub.firstCall.args as [string, unknown[]];
      // Both bot_id AND telegram_user_id must be passed as separate params in the WHERE clause
      expect(params).to.include('bot-1');
      expect(params).to.include(42);
      expect(params).to.have.length.at.least(2);
    });
  });

  // ── upsertConversation ───────────────────────────────────────────────────

  describe('upsertConversation', () => {
    const defaults = {
      llmProvider: 'openai',
      llmModel: 'gpt-4o',
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
    };

    it('calls pool.query with the correct default provider/model values', async () => {
      const row = makeRow();
      // upsertConversation now issues ONE query: INSERT ... ON CONFLICT DO UPDATE RETURNING *
      queryStub.resolves({ rows: [row], rowCount: 1 });
      await upsertConversation('bot123', 99, defaults);
      expect(queryStub.calledOnce).to.be.true;
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('ON CONFLICT');
      expect(sql).to.include('DO UPDATE');
      expect(params).to.include('bot123');
      expect(params).to.include(99);
      expect(params).to.include('openai');
      expect(params).to.include('gpt-4o');
      expect(params).to.include('gpt-4o-mini');
    });

    it('returns the full row from the pg result', async () => {
      const row = makeRow();
      // Single query: INSERT ... ON CONFLICT DO UPDATE SET updated_at = updated_at RETURNING *
      queryStub.resolves({ rows: [row], rowCount: 1 });
      const result = await upsertConversation('bot123', 99, defaults);
      expect(result).to.deep.equal(row);
    });
  });

  // ── updateConversationMessages ───────────────────────────────────────────

  describe('updateConversationMessages', () => {
    it('passes JSON.stringified messages and the correct summary', async () => {
      queryStub.resolves({ rows: [] });
      const messages = [{ role: 'user', content: 'hi' }];
      await updateConversationMessages('bot123', 99, messages, 'a summary');
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('messages');
      expect(params[0]).to.equal(JSON.stringify(messages));
      expect(params).to.include('a summary');
    });

    it('passes an empty JSON array string when messages is empty', async () => {
      queryStub.resolves({ rows: [] });
      await updateConversationMessages('bot123', 99, [], null);
      const [, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(params[0]).to.equal('[]');
      expect(params[1]).to.be.null;
    });
  });

  // ── clearConversation ────────────────────────────────────────────────────

  describe('clearConversation', () => {
    it('sets messages to empty array literal and summary to NULL', async () => {
      queryStub.resolves({ rows: [] });
      await clearConversation('bot123', 99);
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include("'[]'::jsonb");
      expect(sql).to.include('summary = NULL');
      expect(params).to.include('bot123');
      expect(params).to.include(99);
    });

    it('does NOT include system_prompt in the UPDATE', async () => {
      queryStub.resolves({ rows: [] });
      await clearConversation('bot123', 99);
      const [sql] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.not.include('system_prompt');
    });

    // T1-05 — WHERE predicate uses exactly bot_id + telegram_user_id (cross-row isolation)
    it('T1-05: passes exactly [bot-1, 42] as WHERE params — no extra columns leaked into predicate', async () => {
      queryStub.resolves({ rows: [] });
      await clearConversation('bot-1', 42);
      const [, params] = queryStub.firstCall.args as [string, unknown[]];
      // The SQL has no SET params (literals in the query), so the only params are the WHERE values
      expect(params).to.deep.equal(['bot-1', 42]);
    });
  });

  // ── setConversationSystemPrompt ──────────────────────────────────────────

  describe('setConversationSystemPrompt', () => {
    it('updates only system_prompt and updated_at', async () => {
      queryStub.resolves({ rows: [] });
      await setConversationSystemPrompt('bot123', 99, 'You are helpful.');
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('system_prompt');
      expect(sql).to.include('updated_at');
      expect(sql).to.not.include('messages');
      expect(sql).to.not.include('summary');
      expect(params).to.include('You are helpful.');
      expect(params).to.include('bot123');
      expect(params).to.include(99);
    });
  });

  // ── updateConversationProvider ───────────────────────────────────────────

  describe('updateConversationProvider', () => {
    it('updates llm_provider, llm_model, and updated_at', async () => {
      queryStub.resolves({ rows: [] });
      await updateConversationProvider('bot123', 99, 'anthropic', 'claude-3-5-sonnet-20241022');
      const [sql, params] = queryStub.firstCall.args as [string, unknown[]];
      expect(sql).to.include('llm_provider');
      expect(sql).to.include('llm_model');
      expect(sql).to.include('updated_at');
      expect(params).to.include('anthropic');
      expect(params).to.include('claude-3-5-sonnet-20241022');
      expect(params).to.include('bot123');
      expect(params).to.include(99);
    });
  });
});
