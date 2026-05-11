import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { ConversationRow } from '../../src/db/queries/conversations.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 1,
    bot_id: 'bot-1',
    telegram_user_id: 42,
    llm_provider: 'openai',
    llm_model: 'gpt-4o',
    summarization_provider: 'openai',
    summarization_model: 'gpt-4o-mini',
    messages: [],
    summary: null,
    system_prompt: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationService', () => {
  // ── assemble ──────────────────────────────────────────────────────────────
  //
  // assemble() is a pure function — no DB, no async.
  // We import it directly (no esmock needed for the unit-test portion).

  let ConversationService: any;
  let upsertConversationStub: sinon.SinonStub;
  let updateConversationMessagesStub: sinon.SinonStub;

  beforeEach(async () => {
    upsertConversationStub = sinon.stub().resolves(makeRow());
    updateConversationMessagesStub = sinon.stub().resolves();

    const module = await esmock('../../src/services/conversation.ts', {
      '../../src/db/queries/conversations.js': {
        upsertConversation: upsertConversationStub,
        updateConversationMessages: updateConversationMessagesStub,
      },
    });
    ConversationService = module.ConversationService;
  });

  afterEach(async () => {
    sinon.resetHistory();
    await esmock.purge();
  });

  // ── assemble ──────────────────────────────────────────────────────────────

  describe('assemble()', () => {
    it('returns [user] only when no system prompt, no summary, no history', () => {
      const svc = new ConversationService();
      const row = makeRow();
      const { messages } = svc.assemble(row, 'hello');
      expect(messages).to.deep.equal([{ role: 'user', content: 'hello' }]);
    });

    it('inserts system message first when systemPromptOverride is provided', () => {
      const svc = new ConversationService();
      const row = makeRow({ system_prompt: 'original system' });
      const { messages } = svc.assemble(row, 'hi', 'override system');
      expect(messages[0]).to.deep.equal({ role: 'system', content: 'override system' });
      expect(messages[messages.length - 1]).to.deep.equal({ role: 'user', content: 'hi' });
    });

    it('inserts system message from row.system_prompt when no override', () => {
      const svc = new ConversationService();
      const row = makeRow({ system_prompt: 'row system prompt' });
      const { messages } = svc.assemble(row, 'hi');
      expect(messages[0]).to.deep.equal({ role: 'system', content: 'row system prompt' });
    });

    it('injects summary message between system and history when row.summary is non-null', () => {
      const svc = new ConversationService();
      const row = makeRow({
        system_prompt: 'sys',
        summary: 'user likes cats',
        messages: [{ role: 'user', content: 'prev msg' }],
      });
      const { messages, summaryInjected } = svc.assemble(row, 'new msg');
      expect(messages[0]).to.deep.equal({ role: 'system', content: 'sys' });
      expect(messages[1]).to.deep.equal({
        role: 'assistant',
        content: 'Previous conversation summary: user likes cats',
      });
      expect(messages[2]).to.deep.equal({ role: 'user', content: 'prev msg' });
      expect(messages[3]).to.deep.equal({ role: 'user', content: 'new msg' });
      expect(summaryInjected).to.be.true;
    });

    it('omits summary message when row.summary is null', () => {
      const svc = new ConversationService();
      const row = makeRow({ summary: null });
      const { messages, summaryInjected } = svc.assemble(row, 'q');
      expect(messages.some((m: any) => m.content?.startsWith('Previous conversation summary'))).to.be.false;
      expect(summaryInjected).to.be.false;
    });

    it('omits summary message when row.summary is empty string', () => {
      const svc = new ConversationService();
      const row = makeRow({ summary: '' });
      const { messages, summaryInjected } = svc.assemble(row, 'q');
      expect(messages.some((m: any) => m.content?.startsWith('Previous conversation summary'))).to.be.false;
      expect(summaryInjected).to.be.false;
    });

    it('history messages appear in order before new user message', () => {
      const svc = new ConversationService();
      const row = makeRow({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
          { role: 'user', content: 'third' },
        ],
      });
      const { messages } = svc.assemble(row, 'fourth');
      expect(messages).to.deep.equal([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
        { role: 'user', content: 'fourth' },
      ]);
    });

    it('filters out messages with invalid roles, keeps valid surrounding messages, and warns', async () => {
      // Re-import ConversationService with a stubbed logger to observe warn calls
      const loggerWarnStub = sinon.stub();
      const { ConversationService: SvcWithLogger } = await esmock(
        '../../src/services/conversation.ts',
        {
          '../../src/utils/logger.js': {
            logger: {
              debug: sinon.stub(),
              info: sinon.stub(),
              warn: loggerWarnStub,
              error: sinon.stub(),
            },
          },
          '../../src/db/queries/conversations.js': {
            upsertConversation: sinon.stub().resolves(makeRow()),
            updateConversationMessages: sinon.stub().resolves(),
          },
        },
      );

      const svc = new SvcWithLogger();
      const row = makeRow({
        messages: [
          { role: 'user', content: 'valid before' },
          { role: 'function', content: 'invalid role message' },
          { role: 'assistant', content: 'valid after' },
        ],
      });

      const { messages } = svc.assemble(row, 'new msg');

      // Invalid role message must not appear in the assembled output
      const roles = messages.map((m: any) => m.role);
      expect(roles).to.not.include('function');

      // Valid messages before and after the invalid one must be present
      expect(messages.some((m: any) => m.content === 'valid before')).to.be.true;
      expect(messages.some((m: any) => m.content === 'valid after')).to.be.true;

      // logger.warn must have been called once for the invalid role
      expect(loggerWarnStub.calledOnce).to.be.true;
      expect(loggerWarnStub.firstCall.args[0]).to.have.property('invalidCount', 1);
    });
  });

  // ── load ─────────────────────────────────────────────────────────────────

  describe('load()', () => {
    it('calls upsertConversation with env defaults', async () => {
      const svc = new ConversationService();
      await svc.load('bot-1', 42);

      expect(upsertConversationStub.calledOnce).to.be.true;
      const [botId, telegramUserId, defaults] = upsertConversationStub.firstCall.args;
      expect(botId).to.equal('bot-1');
      expect(telegramUserId).to.equal(42);
      expect(defaults).to.have.property('llmProvider', process.env.DEFAULT_LLM_PROVIDER ?? 'openai');
      expect(defaults).to.have.property('llmModel');
      expect(defaults).to.have.property('summarizationProvider');
      expect(defaults).to.have.property('summarizationModel');
    });

    it('returns the row from upsertConversation', async () => {
      const expected = makeRow({ id: 99 });
      upsertConversationStub.resolves(expected);
      const svc = new ConversationService();
      const result = await svc.load('bot-1', 42);
      expect(result).to.deep.equal(expected);
    });
  });

  // ── save ──────────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('calls updateConversationMessages with correct args', async () => {
      const svc = new ConversationService();
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ];
      await svc.save('bot-2', 77, messages, 'some summary');

      expect(updateConversationMessagesStub.calledOnce).to.be.true;
      const [botId, telegramUserId, msgs, summary] = updateConversationMessagesStub.firstCall.args;
      expect(botId).to.equal('bot-2');
      expect(telegramUserId).to.equal(77);
      expect(msgs).to.deep.equal(messages);
      expect(summary).to.equal('some summary');
    });

    it('passes null summary through correctly', async () => {
      const svc = new ConversationService();
      await svc.save('bot-3', 10, [], null);
      const [, , , summary] = updateConversationMessagesStub.firstCall.args;
      expect(summary).to.be.null;
    });
  });
});
