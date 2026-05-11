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

describe('AgentService', () => {
  let clearConversationStub: sinon.SinonStub;
  let updateConversationProviderStub: sinon.SinonStub;

  // ── Shared beforeEach/afterEach ───────────────────────────────────────────
  // Each test uses its own esmock call so it can control the `env` mock.
  // We only set up the DB stubs here; the actual AgentService is esmocked
  // per-test or per-describe block.

  beforeEach(() => {
    clearConversationStub = sinon.stub().resolves();
    updateConversationProviderStub = sinon.stub().resolves();
  });

  afterEach(async () => {
    sinon.resetHistory();
    await esmock.purge();
  });

  // Helper: build AgentService class mocked with given env values
  async function buildAgentService(envOverrides: Record<string, string | undefined> = {}) {
    const baseEnv = {
      DEFAULT_LLM_PROVIDER: 'openai',
      DEFAULT_LLM_MODEL: 'gpt-4o',
      DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
      DEFAULT_SUMMARIZATION_MODEL: 'gpt-4o-mini',
      FALLBACK_LLM_PROVIDER: undefined,
      FALLBACK_LLM_MODEL: undefined,
      ...envOverrides,
    };

    const module = await esmock('../../src/services/agent.ts', {
      '../../src/config/env.js': { env: baseEnv },
      '../../src/db/queries/conversations.js': {
        clearConversation: clearConversationStub,
        updateConversationProvider: updateConversationProviderStub,
      },
    });
    return module.AgentService;
  }

  // ── chat ──────────────────────────────────────────────────────────────────

  describe('chat()', () => {
    it('happy path — loads, assembles, completes, saves, returns reply string', async () => {
      const AgentService = await buildAgentService();

      const row = makeRow();
      const assembled = [{ role: 'user', content: 'hello' }];
      const reply = 'Hello back!';

      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub().returns({ messages: assembled, summaryInjected: false }),
        save: sinon.stub().resolves(),
      };
      const providerStub = { complete: sinon.stub().resolves(reply) };
      const factoryStub = { create: sinon.stub().returns(providerStub) };
      const summarizationSvc = { maybeSummarize: sinon.stub().resolves() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);
      const result = await svc.chat('bot-1', 42, 'hello');

      expect(result).to.equal(reply);
      expect(conversationSvc.load.calledOnce).to.be.true;
      expect(conversationSvc.assemble.calledOnce).to.be.true;
      expect(providerStub.complete.calledOnce).to.be.true;
      expect(conversationSvc.save.calledOnce).to.be.true;
    });

    it('triggers fallback when primary throws and FALLBACK vars are set', async () => {
      const AgentService = await buildAgentService({
        FALLBACK_LLM_PROVIDER: 'anthropic',
        FALLBACK_LLM_MODEL: 'claude-3-5-haiku-20241022',
      });

      const row = makeRow();
      const assembled = [{ role: 'user', content: 'hi' }];
      const fallbackReply = 'fallback reply';

      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub().returns({ messages: assembled, summaryInjected: false }),
        save: sinon.stub().resolves(),
      };
      const primaryProvider = { complete: sinon.stub().rejects(new Error('primary failed')) };
      const fallbackProvider = { complete: sinon.stub().resolves(fallbackReply) };
      const factoryStub = {
        create: sinon.stub()
          .onFirstCall().returns(primaryProvider)
          .onSecondCall().returns(fallbackProvider),
      };
      const summarizationSvc = { maybeSummarize: sinon.stub().resolves() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);
      const result = await svc.chat('bot-1', 42, 'hi');

      expect(result).to.equal(fallbackReply);
      expect(factoryStub.create.callCount).to.equal(2);
      expect(fallbackProvider.complete.calledOnce).to.be.true;
    });

    it('rethrows primary error when FALLBACK vars are not set', async () => {
      const AgentService = await buildAgentService({
        FALLBACK_LLM_PROVIDER: undefined,
        FALLBACK_LLM_MODEL: undefined,
      });

      const row = makeRow();
      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub().returns([{ role: 'user', content: 'hi' }]),
        save: sinon.stub().resolves(),
      };
      const primaryErr = new Error('primary failed');
      const providerStub = { complete: sinon.stub().rejects(primaryErr) };
      const factoryStub = { create: sinon.stub().returns(providerStub) };
      const summarizationSvc = { maybeSummarize: sinon.stub().resolves() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);

      let thrown: unknown;
      try {
        await svc.chat('bot-1', 42, 'hi');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).to.equal(primaryErr);
    });

    it('rethrows fallback error when fallback also fails', async () => {
      const AgentService = await buildAgentService({
        FALLBACK_LLM_PROVIDER: 'anthropic',
        FALLBACK_LLM_MODEL: 'claude-3-5-haiku-20241022',
      });

      const row = makeRow();
      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub().returns([{ role: 'user', content: 'hi' }]),
        save: sinon.stub().resolves(),
      };
      const fallbackErr = new Error('fallback also failed');
      const primaryProvider = { complete: sinon.stub().rejects(new Error('primary failed')) };
      const fallbackProvider = { complete: sinon.stub().rejects(fallbackErr) };
      const factoryStub = {
        create: sinon.stub()
          .onFirstCall().returns(primaryProvider)
          .onSecondCall().returns(fallbackProvider),
      };
      const summarizationSvc = { maybeSummarize: sinon.stub().resolves() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);

      let thrown: unknown;
      try {
        await svc.chat('bot-1', 42, 'hi');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).to.equal(fallbackErr);
    });

    it('calls maybeSummarize after saving context', async () => {
      const AgentService = await buildAgentService();

      const row = makeRow();
      const assembled = [{ role: 'user', content: 'hello' }];

      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub().returns({ messages: assembled, summaryInjected: false }),
        save: sinon.stub().resolves(),
      };
      const providerStub = { complete: sinon.stub().resolves('reply') };
      const factoryStub = { create: sinon.stub().returns(providerStub) };
      const maybeSummarizeStub = sinon.stub().resolves();
      const summarizationSvc = { maybeSummarize: maybeSummarizeStub };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);
      await svc.chat('bot-1', 42, 'hello');

      expect(conversationSvc.save.calledOnce).to.be.true;
      expect(maybeSummarizeStub.calledOnce).to.be.true;
      expect(conversationSvc.save.calledBefore(maybeSummarizeStub)).to.be.true;
    });

    // QA-4: partial fallback env (FALLBACK_LLM_PROVIDER set, FALLBACK_LLM_MODEL undefined)
    it('QA-4: does not attempt fallback when FALLBACK_LLM_PROVIDER set but FALLBACK_LLM_MODEL is undefined', async () => {
      const AgentService = await buildAgentService({
        FALLBACK_LLM_PROVIDER: 'anthropic',
        FALLBACK_LLM_MODEL: undefined,
      });

      const row = makeRow();
      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub().returns([{ role: 'user', content: 'hi' }]),
        save: sinon.stub().resolves(),
      };
      const primaryErr = new Error('primary failed');
      const primaryProvider = { complete: sinon.stub().rejects(primaryErr) };
      // factoryStub tracks call count — if fallback were attempted it would be called twice
      const factoryStub = { create: sinon.stub().returns(primaryProvider) };
      const summarizationSvc = { maybeSummarize: sinon.stub().resolves() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);

      let thrown: unknown;
      try {
        await svc.chat('bot-1', 42, 'hi');
      } catch (err) {
        thrown = err;
      }

      // Implementation guards on FALLBACK_LLM_PROVIDER && FALLBACK_LLM_MODEL,
      // so with model undefined the primary error must be rethrown (not silently swallowed,
      // and no second factory.create call for the fallback path).
      expect(thrown).to.equal(primaryErr);
      // factory.create called only once (primary) — fallback path was NOT entered
      expect(factoryStub.create.callCount).to.equal(1);
    });

    // QA-5: void-discarded maybeSummarize rejection does not propagate to chat() caller
    it('QA-5: chat() resolves successfully even when maybeSummarize rejects asynchronously', async () => {
      const AgentService = await buildAgentService();

      const row = makeRow();
      const assembled = [{ role: 'user', content: 'hello' }];
      const reply = 'Async safe reply';

      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub().returns({ messages: assembled, summaryInjected: false }),
        save: sinon.stub().resolves(),
      };
      const providerStub = { complete: sinon.stub().resolves(reply) };
      const factoryStub = { create: sinon.stub().returns(providerStub) };
      // Real async rejection — not resolved synchronously, tests true void-discard semantics
      const summarizationSvc = {
        maybeSummarize: sinon.stub().rejects(new Error('summarization failed')),
      };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);
      const result = await svc.chat('bot-1', 42, 'hello');

      // chat() must resolve to the reply string regardless of summarization failure
      expect(result).to.equal(reply);
    });
  });

  // ── clearContext ──────────────────────────────────────────────────────────

  describe('clearContext()', () => {
    it('calls clearConversation with correct args', async () => {
      const AgentService = await buildAgentService();

      const conversationSvc = { load: sinon.stub(), assemble: sinon.stub(), save: sinon.stub() };
      const summarizationSvc = { maybeSummarize: sinon.stub() };
      const factoryStub = { create: sinon.stub() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);
      await svc.clearContext('bot-1', 42);

      expect(clearConversationStub.calledOnceWith('bot-1', 42)).to.be.true;
    });
  });

  // ── switchProvider ────────────────────────────────────────────────────────

  describe('switchProvider()', () => {
    it('calls updateConversationProvider with correct args', async () => {
      const AgentService = await buildAgentService();

      const conversationSvc = { load: sinon.stub(), assemble: sinon.stub(), save: sinon.stub() };
      const summarizationSvc = { maybeSummarize: sinon.stub() };
      const factoryStub = { create: sinon.stub() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);
      await svc.switchProvider('bot-1', 42, 'anthropic', 'claude-3-5-sonnet-20241022');

      expect(updateConversationProviderStub.calledOnceWith(
        'bot-1', 42, 'anthropic', 'claude-3-5-sonnet-20241022',
      )).to.be.true;
    });

    it('throws descriptive error for unknown provider', async () => {
      const AgentService = await buildAgentService();

      const conversationSvc = { load: sinon.stub(), assemble: sinon.stub(), save: sinon.stub() };
      const summarizationSvc = { maybeSummarize: sinon.stub() };
      const factoryStub = { create: sinon.stub() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);

      let thrown: unknown;
      try {
        await svc.switchProvider('bot-1', 42, 'grok', 'grok-2');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect((thrown as Error).message).to.include('grok');
      expect(updateConversationProviderStub.called).to.be.false;
    });
  });

  // ── generateWarmPrompt ────────────────────────────────────────────────────

  describe('generateWarmPrompt()', () => {
    it('returns empty string when no conversation history exists', async () => {
      const AgentService = await buildAgentService();

      const row = makeRow({ messages: [] });
      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub(),
        save: sinon.stub(),
      };
      const summarizationSvc = { maybeSummarize: sinon.stub() };
      const factoryStub = { create: sinon.stub() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);
      const result = await svc.generateWarmPrompt('manager-bot', 99);

      expect(result).to.equal('');
      expect(factoryStub.create.called).to.be.false;
    });

    it('returns a string when LLM call succeeds', async () => {
      const AgentService = await buildAgentService();

      const row = makeRow({
        messages: [
          { role: 'user', content: 'I love hiking' },
          { role: 'assistant', content: 'That sounds great!' },
        ],
      });
      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub(),
        save: sinon.stub(),
      };

      const warmPrompt = 'User is an outdoor enthusiast who enjoys hiking.';
      const providerStub = { complete: sinon.stub().resolves(warmPrompt) };
      const factoryStub = { create: sinon.stub().returns(providerStub) };
      const summarizationSvc = { maybeSummarize: sinon.stub() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);
      const result = await svc.generateWarmPrompt('manager-bot', 99);

      expect(result).to.equal(warmPrompt);
      expect(factoryStub.create.calledOnce).to.be.true;
      expect(providerStub.complete.calledOnce).to.be.true;
    });

    // QA-6: provider.complete failure inside generateWarmPrompt must not throw — returns null
    it('QA-6: returns null (falsy) when provider.complete rejects inside generateWarmPrompt', async () => {
      const AgentService = await buildAgentService();

      const row = makeRow({
        messages: [
          { role: 'user', content: 'I love hiking' },
          { role: 'assistant', content: 'That sounds great!' },
        ],
      });
      const conversationSvc = {
        load: sinon.stub().resolves(row),
        assemble: sinon.stub(),
        save: sinon.stub(),
      };
      // Provider that always rejects — simulates LLM failure during warm prompt generation
      const failingProvider = { complete: sinon.stub().rejects(new Error('LLM timeout')) };
      const factoryStub = { create: sinon.stub().returns(failingProvider) };
      const summarizationSvc = { maybeSummarize: sinon.stub() };

      const svc = new AgentService(conversationSvc, summarizationSvc, factoryStub);
      const result = await svc.generateWarmPrompt('manager', 42);

      // Implementation catches and returns null — must NOT throw
      expect(result).to.be.null;
      expect(Boolean(result)).to.be.false; // confirms falsy
    });
  });
});
