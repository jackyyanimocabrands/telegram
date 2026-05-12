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
