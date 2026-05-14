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
    id: 'uuid-1',
    bot_id: 'bot-1',
    telegram_user_id: 42,
    llm_provider: 'openai',
    llm_model: 'gpt-4o',
    summarization_provider: 'openai',
    summarization_model: 'gpt-4o-mini',
    messages: [],
    summary: null,
    system_prompt: null,
    force_summarize: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const mockLlmConfig = {
  chat: [
    { provider: 'openai', model: 'gpt-4o', temperature: 0.7 },
  ],
  summarization: [
    { provider: 'openai', model: 'gpt-4o-mini', temperature: 0.7 },
  ],
};

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
      '../../src/config/llm-config.js': { llmConfig: mockLlmConfig },
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
    it('calls upsertConversation with llmConfig values as initialMetadata', async () => {
      const svc = new ConversationService();
      await svc.load('bot-1', 42);

      expect(upsertConversationStub.calledOnce).to.be.true;
      const [botId, telegramUserId, initialMetadata] = upsertConversationStub.firstCall.args;
      expect(botId).to.equal('bot-1');
      expect(telegramUserId).to.equal(42);
      // Values come from mockLlmConfig, not process.env
      expect(initialMetadata).to.have.property('llmProvider', 'openai');
      expect(initialMetadata).to.have.property('llmModel', 'gpt-4o');
      expect(initialMetadata).to.have.property('summarizationProvider', 'openai');
      expect(initialMetadata).to.have.property('summarizationModel', 'gpt-4o-mini');
    });

    it('returns the row from upsertConversation', async () => {
      const expected = makeRow({ id: 'uuid-99' });
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

    it('passes lastUsed arg through to updateConversationMessages when provided', async () => {
      const svc = new ConversationService();
      const lastUsed = { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', summarizationProvider: 'openai', summarizationModel: 'gpt-4o-mini' };
      await svc.save('bot-4', 5, [], null, lastUsed);
      const [, , , , passedLastUsed] = updateConversationMessagesStub.firstCall.args;
      expect(passedLastUsed).to.deep.equal(lastUsed);
    });
  });
});
