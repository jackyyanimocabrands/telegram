import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { ConversationRow } from '../../src/db/queries/conversations.js';
import type { LlmMessage } from '../../src/services/llm/provider.js';

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

/** Build a message list whose token estimate exceeds the given budget. */
function buildLargeMessages(tokenBudget: number): LlmMessage[] {
  // estimateTokens = floor(totalChars / 4), so we need chars > budget * 4 + 1
  const bigContent = 'x'.repeat(tokenBudget * 4 + 100);
  return [{ role: 'user', content: bigContent }];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SummarizationService', () => {
  let SummarizationService: any;
  let updateConversationMessagesStub: sinon.SinonStub;
  // Stubs for model-registry and token-estimator injected via esmock
  let getModelConfigStub: sinon.SinonStub;
  let estimateTokensStub: sinon.SinonStub;

  beforeEach(async () => {
    updateConversationMessagesStub = sinon.stub().resolves();
    getModelConfigStub = sinon.stub().returns({ maxTokens: 128000 });
    estimateTokensStub = sinon.stub();

    const module = await esmock('../../src/services/summarization.ts', {
      '../../src/db/queries/conversations.js': {
        updateConversationMessages: updateConversationMessagesStub,
      },
      '../../src/services/llm/model-registry.js': {
        getModelConfig: getModelConfigStub,
      },
      '../../src/services/llm/token-estimator.js': {
        estimateTokens: estimateTokensStub,
      },
    });
    SummarizationService = module.SummarizationService;
  });

  afterEach(async () => {
    sinon.resetHistory();
    await esmock.purge();
  });

  describe('maybeSummarize()', () => {
    it('skips when token estimate is under budget (no factory.create call)', async () => {
      // budget = floor(128000 / 10) = 12800; estimate = 100 → under budget
      estimateTokensStub.returns(100);

      const factoryStub = { create: sinon.stub() };
      const svc = new SummarizationService(factoryStub);

      const row = makeRow();
      await svc.maybeSummarize('bot-1', 42, row, [{ role: 'user', content: 'hi' }], []);

      expect(factoryStub.create.called).to.be.false;
      expect(updateConversationMessagesStub.called).to.be.false;
    });

    it('calls factory.create with summarization_provider and summarization_model when over budget', async () => {
      estimateTokensStub.returns(99999); // over budget

      const providerStub = { invoke: sinon.stub().resolves({ content: 'summary text' }) };
      const factoryStub = { create: sinon.stub().returns(providerStub) };

      const messages = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: 'd' },
      ];

      const row = makeRow({
        summarization_provider: 'anthropic',
        summarization_model: 'claude-3-5-haiku-20241022',
        messages,
      });

      const svc = new SummarizationService(factoryStub);
      await svc.maybeSummarize('bot-1', 42, row, [], messages);

      expect(factoryStub.create.calledOnce).to.be.true;
      expect(factoryStub.create.firstCall.args[0]).to.equal('anthropic');
      expect(factoryStub.create.firstCall.args[1]).to.equal('claude-3-5-haiku-20241022');
    });

    it('calls updateConversationMessages with trimmed messages and new summary', async () => {
      estimateTokensStub.returns(99999); // over budget

      const newSummary = 'user likes stargazing';
      const providerStub = { invoke: sinon.stub().resolves({ content: newSummary }) };
      const factoryStub = { create: sinon.stub().returns(providerStub) };

      const messages = [
        { role: 'user', content: 'msg-1' },
        { role: 'assistant', content: 'msg-2' },
        { role: 'user', content: 'msg-3' },
        { role: 'assistant', content: 'msg-4' },
      ];

      const row = makeRow({ messages });
      const svc = new SummarizationService(factoryStub);
      await svc.maybeSummarize('bot-1', 42, row, [], messages);

      expect(updateConversationMessagesStub.calledOnce).to.be.true;
      const [botId, telegramUserId, remainingMsgs, summary] =
        updateConversationMessagesStub.firstCall.args;
      expect(botId).to.equal('bot-1');
      expect(telegramUserId).to.equal(42);
      // oldest 50% = slice(0, 2) summarised → remaining = slice(2)
      expect(remainingMsgs).to.deep.equal(messages.slice(2));
      expect(summary).to.equal(newSummary);
    });

    it('catches and logs error if LLM call throws, does NOT rethrow', async () => {
      estimateTokensStub.returns(99999); // over budget

      const providerStub = { invoke: sinon.stub().rejects(new Error('LLM blew up')) };
      const factoryStub = { create: sinon.stub().returns(providerStub) };

      const row = makeRow({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      });

      const svc = new SummarizationService(factoryStub);

      let threw = false;
      try {
        await svc.maybeSummarize('bot-1', 42, row, [], row.messages);
      } catch {
        threw = true;
      }

      expect(threw).to.be.false;
      expect(updateConversationMessagesStub.called).to.be.false;
    });

    it('QA-3: calls logger.error when LLM throws (error-swallowing test with logger assertion)', async () => {
      // Build a fresh esmock that also replaces the logger so we can spy on logger.error
      const loggerErrorSpy = sinon.spy();
      const loggerStub = {
        debug: sinon.stub(),
        info: sinon.stub(),
        warn: sinon.stub(),
        error: loggerErrorSpy,
      };

      const localUpdateStub = sinon.stub().resolves();
      const localGetModelConfigStub = sinon.stub().returns({ maxTokens: 128000 });
      const localEstimateTokensStub = sinon.stub().returns(99999); // over budget

      const { SummarizationService: SvcWithLogger } = await esmock(
        '../../src/services/summarization.ts',
        {
          '../../src/db/queries/conversations.js': {
            updateConversationMessages: localUpdateStub,
          },
          '../../src/services/llm/model-registry.js': {
            getModelConfig: localGetModelConfigStub,
          },
          '../../src/services/llm/token-estimator.js': {
            estimateTokens: localEstimateTokensStub,
          },
          '../../src/utils/logger.js': {
            logger: loggerStub,
          },
        },
      );

      const providerStub = { invoke: sinon.stub().rejects(new Error('LLM blew up')) };
      const factoryStub = { create: sinon.stub().returns(providerStub) };

      const row = makeRow({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      });

      const svc = new SvcWithLogger(factoryStub);
      await svc.maybeSummarize('bot-1', 42, row, [], row.messages);

      // Must not rethrow
      // Must call logger.error exactly once to record the failure
      expect(loggerErrorSpy.calledOnce).to.be.true;
    });

    it('catches and logs error if updateConversationMessages throws, does NOT rethrow', async () => {
      estimateTokensStub.returns(99999); // over budget

      const providerStub = { invoke: sinon.stub().resolves({ content: 'summary' }) };
      const factoryStub = { create: sinon.stub().returns(providerStub) };
      updateConversationMessagesStub.rejects(new Error('DB error'));

      const row = makeRow({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      });

      const svc = new SummarizationService(factoryStub);

      let threw = false;
      try {
        await svc.maybeSummarize('bot-1', 42, row, [], row.messages);
      } catch {
        threw = true;
      }

      expect(threw).to.be.false;
    });
  });
});
