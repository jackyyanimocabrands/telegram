import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';

// ---------------------------------------------------------------------------
// Helpers — stub ConversationRow
// ---------------------------------------------------------------------------

function makeRow(overrides: Record<string, unknown> = {}) {
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
// Stub ConversationService
// ---------------------------------------------------------------------------

function makeConvService(rowOverrides: Record<string, unknown> = {}) {
  return {
    load: sinon.stub().resolves(makeRow(rowOverrides)),
    save: sinon.stub().resolves(),
    clearMessages: sinon.stub().resolves(),
    updateProvider: sinon.stub().resolves(),
  };
}

// ---------------------------------------------------------------------------
// Stub model factory
// ---------------------------------------------------------------------------

function makeModelFactory(reply = 'test reply') {
  const stubModel = {
    invoke: sinon.stub().resolves(new AIMessage(reply)),
  };
  const stubFactory = {
    create: sinon.stub().returns(stubModel),
  };
  return { stubModel, stubFactory };
}

// ---------------------------------------------------------------------------
// Build AgentService with esmocked env + DB stubs
// ---------------------------------------------------------------------------

let setConversationSystemPromptStub: sinon.SinonStub;

async function buildAgentService(envOverrides: Record<string, string | undefined> = {}) {
  const baseEnv = {
    DEFAULT_LLM_PROVIDER: 'openai',
    DEFAULT_LLM_MODEL: 'gpt-4o',
    DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
    DEFAULT_SUMMARIZATION_MODEL: 'gpt-4o-mini',
    ...envOverrides,
  };

  setConversationSystemPromptStub = sinon.stub().resolves();

  const module = await esmock('../../src/services/agent.ts', {
    '../../src/config/env.js': { env: baseEnv },
    '../../src/db/queries/conversations.js': {
      setConversationSystemPrompt: setConversationSystemPromptStub,
      updateConversationProvider: sinon.stub().resolves(),
      clearConversation: sinon.stub().resolves(),
    },
  });
  return module.AgentService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentService (LangGraph)', () => {
  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // ── chat() ────────────────────────────────────────────────────────────────

  describe('chat()', () => {
    it('returns string reply from AI model response', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory('Hello from AI');

      const svc = new AgentService(convSvc, stubFactory);
      const result = await svc.chat('bot-1', 42, 'hello');

      expect(result).to.be.a('string');
      expect(result).to.equal('Hello from AI');
    });

    it('empty conversation history — still returns reply', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService({ messages: [] });
      const { stubFactory } = makeModelFactory('Reply with no history');

      const svc = new AgentService(convSvc, stubFactory);
      const result = await svc.chat('bot-1', 42, 'first message');

      expect(result).to.equal('Reply with no history');
    });

    it('systemPromptOverride causes model.invoke to receive a SystemMessage', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubModel, stubFactory } = makeModelFactory('system-aware reply');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('bot-1', 42, 'hello', 'You are a pirate.');

      // model.invoke must have been called with messages that include a SystemMessage
      expect(stubModel.invoke.calledOnce).to.be.true;
      const [messages] = stubModel.invoke.firstCall.args as [{ getType(): string; content: string }[]];
      const systemMsg = messages.find(m => m.getType() === 'system');
      expect(systemMsg).to.exist;
      expect(systemMsg!.content).to.equal('You are a pirate.');
    });

    it('existing history messages appear in model.invoke call', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService({
        messages: [
          { role: 'user', content: 'prev question' },
          { role: 'assistant', content: 'prev answer' },
        ],
      });
      const { stubModel, stubFactory } = makeModelFactory('reply with context');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('bot-1', 42, 'follow-up');

      const [messages] = stubModel.invoke.firstCall.args as [{ content: unknown }[]];
      const contents = messages.map(m => m.content);
      expect(contents).to.include('prev question');
      expect(contents).to.include('prev answer');
      expect(contents).to.include('follow-up');
    });

    it('existing summary appears as AIMessage before history in model.invoke call', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService({
        summary: 'User likes TypeScript',
        messages: [{ role: 'user', content: 'recent msg' }],
      });
      const { stubModel, stubFactory } = makeModelFactory('reply');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('bot-1', 42, 'new msg');

      const [messages] = stubModel.invoke.firstCall.args as [{ getType(): string; content: string }[]];
      const aiMessages = messages.filter(m => m.getType() === 'ai');
      const sentinelMsg = aiMessages.find(m => m.content.includes('User likes TypeScript'));
      expect(sentinelMsg).to.exist;
    });

    it('conversationService.save is called after model responds', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory('saved reply');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('bot-1', 42, 'hello');

      expect(convSvc.save.calledOnce).to.be.true;
    });

    it('conversationService.load is called with correct botId and userId', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('my-bot', 99, 'hello');

      expect(convSvc.load.calledOnceWith('my-bot', 99)).to.be.true;
    });

    it('uses provider and model from conversation row', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService({
        llm_provider: 'anthropic',
        llm_model: 'claude-3-5-sonnet-20241022',
      });
      const { stubFactory } = makeModelFactory();

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('bot-1', 42, 'hello');

      expect(stubFactory.create.calledWith('anthropic', 'claude-3-5-sonnet-20241022')).to.be.true;
    });
  });

  // ── clearContext() ────────────────────────────────────────────────────────

  describe('clearContext()', () => {
    it('calls conversationService.clearMessages with correct botId and userId', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const svc = new AgentService(convSvc, stubFactory);
      await svc.clearContext('bot-1', 42);

      expect(convSvc.clearMessages.calledOnceWith('bot-1', 42)).to.be.true;
    });
  });

  // ── switchProvider() ──────────────────────────────────────────────────────

  describe('switchProvider()', () => {
    it('calls conversationService.updateProvider with correct args', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const svc = new AgentService(convSvc, stubFactory);
      await svc.switchProvider('bot-1', 42, 'anthropic', 'claude-3-5-sonnet-20241022');

      expect(convSvc.updateProvider.calledOnceWith(
        'bot-1', 42, 'anthropic', 'claude-3-5-sonnet-20241022',
      )).to.be.true;
    });

    it('validates provider by calling modelFactory.create before updating', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const svc = new AgentService(convSvc, stubFactory);
      await svc.switchProvider('bot-1', 42, 'anthropic', 'claude-3-5-haiku-20241022');

      // factory.create called to validate the new provider is instantiable
      expect(stubFactory.create.calledWith('anthropic', 'claude-3-5-haiku-20241022')).to.be.true;
    });

    it('propagates error from modelFactory.create (bad API key)', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const stubFactory = {
        create: sinon.stub().throws(new Error('API key not configured')),
      };

      const svc = new AgentService(convSvc, stubFactory);

      let thrown: unknown;
      try {
        await svc.switchProvider('bot-1', 42, 'openai', 'gpt-4o');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).to.be.instanceOf(Error);
      expect((thrown as Error).message).to.include('API key not configured');
      // updateProvider must NOT be called when factory.create threw
      expect(convSvc.updateProvider.called).to.be.false;
    });
  });

  // ── generateWarmPrompt() ──────────────────────────────────────────────────

  describe('generateWarmPrompt()', () => {
    it('returns null when conversation has no messages', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService({ messages: [] });
      const { stubFactory } = makeModelFactory();

      const svc = new AgentService(convSvc, stubFactory);
      const result = await svc.generateWarmPrompt('manager-bot', 99);

      expect(result).to.be.null;
      expect(stubFactory.create.called).to.be.false;
    });

    it('returns a non-empty string when conversation has messages', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService({
        messages: [
          { role: 'user', content: 'I love TypeScript' },
          { role: 'assistant', content: 'Great choice!' },
        ],
      });
      const warmPrompt = 'User is a TypeScript enthusiast who values type safety.';
      const { stubFactory } = makeModelFactory(warmPrompt);

      const svc = new AgentService(convSvc, stubFactory);
      const result = await svc.generateWarmPrompt('manager-bot', 99);

      expect(result).to.be.a('string');
      expect(result).to.equal(warmPrompt);
    });

    it('calls modelFactory.create with DEFAULT_SUMMARIZATION_PROVIDER and MODEL', async () => {
      const AgentService = await buildAgentService({
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        DEFAULT_SUMMARIZATION_MODEL: 'gpt-4o-mini',
      });
      const convSvc = makeConvService({
        messages: [{ role: 'user', content: 'hello' }],
      });
      const { stubFactory } = makeModelFactory('warm prompt text');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.generateWarmPrompt('manager-bot', 99);

      expect(stubFactory.create.calledWith('openai', 'gpt-4o-mini')).to.be.true;
    });

    it('returns null when model.invoke rejects (LLM failure)', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService({
        messages: [{ role: 'user', content: 'hello' }],
      });
      const failingModel = {
        invoke: sinon.stub().rejects(new Error('LLM timeout')),
      };
      const stubFactory = { create: sinon.stub().returns(failingModel) };

      const svc = new AgentService(convSvc, stubFactory);
      const result = await svc.generateWarmPrompt('manager-bot', 99);

      expect(result).to.be.null;
    });

    // T8: prompt structure verification
    it('invoke receives array whose first element is a SystemMessage', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService({
        messages: [{ role: 'user', content: 'Tell me about yourself.' }],
      });
      const { stubModel, stubFactory } = makeModelFactory('warm persona text');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.generateWarmPrompt('manager-bot', 99);

      expect(stubModel.invoke.calledOnce).to.be.true;
      const [invokeArgs] = stubModel.invoke.firstCall.args as [unknown[]];
      expect(invokeArgs[0]).to.be.instanceOf(SystemMessage);
    });

    it('invoke receives array whose last element is a HumanMessage', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService({
        messages: [{ role: 'user', content: 'Tell me about yourself.' }],
      });
      const { stubModel, stubFactory } = makeModelFactory('warm persona text');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.generateWarmPrompt('manager-bot', 99);

      expect(stubModel.invoke.calledOnce).to.be.true;
      const [invokeArgs] = stubModel.invoke.firstCall.args as [unknown[]];
      expect(invokeArgs[invokeArgs.length - 1]).to.be.instanceOf(HumanMessage);
    });
  });

  // ── checkBudget branch — summarize fires when over budget ─────────────────

  describe('checkBudget router (summarize path)', () => {
    it('save is called even after summarization runs (graph completes)', async () => {
      const AgentService = await buildAgentService();

      // Use unknown model to get FALLBACK budget (Math.floor(4096 * 0.8) = 3276 tokens).
      // 20 messages × 700 chars = 14000 chars → 3500 tokens > 3276 → triggers summarize.
      // This keeps the test fast while reliably hitting the summarize branch.
      const longContent = 'x'.repeat(700);
      const manyMessages = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longContent,
      }));

      const convSvc = makeConvService({
        messages: manyMessages,
        llm_model: 'unknown-model-xyz', // FALLBACK maxTokens=4096, budget=3276
      });

      // Both agent and summarizer use the same factory stub
      const { stubFactory } = makeModelFactory('reply after summarization');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('bot-1', 42, 'trigger summarization');

      // save must be called regardless of which branch (save always runs last)
      expect(convSvc.save.calledOnce).to.be.true;
    });

    it('modelFactory.create called at least twice when summarize path fires (agent + summarizer)', async () => {
      const AgentService = await buildAgentService();

      // Budget math (checkBudgetRouter uses maxTokens * 0.8, estimateTokens = floor(chars/4)):
      //   Unknown model → FALLBACK maxTokens=4096, budget = floor(4096*0.8) = 3276 tokens
      //   To trigger summarize: need currentTokens > 3276 → need > 13104 chars total.
      //   20 messages × 700 chars = 14000 chars → 3500 tokens > 3276 ✓
      //   Using unknown model ensures FALLBACK regardless of esmock module wiring.
      const longContent = 'y'.repeat(700);
      const manyMessages = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longContent,
      }));

      const convSvc = makeConvService({ messages: manyMessages, llm_model: 'unknown-model-xyz' });
      const { stubFactory } = makeModelFactory('reply');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('bot-1', 42, 'long conversation');

      // At least 2 create() calls: agent model + summarizer model
      expect(stubFactory.create.callCount).to.be.at.least(2);
    });
  });

  // ── seedSystemPrompt() ────────────────────────────────────────────────────

  describe('seedSystemPrompt()', () => {
    it('calls setConversationSystemPrompt DB query with correct args', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const svc = new AgentService(convSvc, stubFactory);
      await svc.seedSystemPrompt('bot-1', 42, 'You are a helpful assistant.');

      expect(setConversationSystemPromptStub.calledOnceWith(
        'bot-1', 42, 'You are a helpful assistant.',
      )).to.be.true;
    });
  });

  // ── chatStream() ──────────────────────────────────────────────────────────

  describe('chatStream()', () => {
    /**
     * Build a fake compiled graph with a controllable `streamEvents` async
     * generator and a regular `invoke` stub (needed by the AgentService
     * constructor path, but not exercised in these tests because we inject
     * the graph directly).
     */
    function makeFakeGraph(events: object[]) {
      async function* generateEvents() {
        for (const ev of events) {
          yield ev;
        }
      }
      return {
        streamEvents: sinon.stub().returns(generateEvents()),
        invoke: sinon.stub().resolves({ messages: [] }),
      };
    }

    it('yields tokens emitted by the agent node', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const fakeGraph = makeFakeGraph([
        { event: 'on_chat_model_stream', metadata: { langgraph_node: 'agent' }, data: { chunk: { content: 'Hello' } } },
        { event: 'on_chat_model_stream', metadata: { langgraph_node: 'agent' }, data: { chunk: { content: ' world' } } },
      ]);

      const svc = new AgentService(convSvc, stubFactory, fakeGraph as any);
      const tokens: string[] = [];
      for await (const t of svc.chatStream('bot-1', 42, 'hi')) {
        tokens.push(t);
      }

      expect(tokens).to.deep.equal(['Hello', ' world']);
    });

    it('suppresses tokens from non-agent nodes (e.g. summarize)', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const fakeGraph = makeFakeGraph([
        { event: 'on_chat_model_stream', metadata: { langgraph_node: 'summarize' }, data: { chunk: { content: 'summarizer token' } } },
        { event: 'on_chat_model_stream', metadata: { langgraph_node: 'agent' }, data: { chunk: { content: 'real token' } } },
      ]);

      const svc = new AgentService(convSvc, stubFactory, fakeGraph as any);
      const tokens: string[] = [];
      for await (const t of svc.chatStream('bot-1', 42, 'hi')) {
        tokens.push(t);
      }

      expect(tokens).to.deep.equal(['real token']);
      expect(tokens).to.not.include('summarizer token');
    });

    it('suppresses non-stream lifecycle events (on_chain_start, on_chain_end)', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const fakeGraph = makeFakeGraph([
        { event: 'on_chain_start', metadata: { langgraph_node: 'agent' }, data: {} },
        { event: 'on_chain_end', metadata: { langgraph_node: 'agent' }, data: {} },
        { event: 'on_chat_model_stream', metadata: { langgraph_node: 'agent' }, data: { chunk: { content: 'only me' } } },
      ]);

      const svc = new AgentService(convSvc, stubFactory, fakeGraph as any);
      const tokens: string[] = [];
      for await (const t of svc.chatStream('bot-1', 42, 'hi')) {
        tokens.push(t);
      }

      expect(tokens).to.deep.equal(['only me']);
    });

    it('yields nothing when agent node emits empty-string content', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const fakeGraph = makeFakeGraph([
        { event: 'on_chat_model_stream', metadata: { langgraph_node: 'agent' }, data: { chunk: { content: '' } } },
        { event: 'on_chat_model_stream', metadata: { langgraph_node: 'agent' }, data: { chunk: { content: '' } } },
      ]);

      const svc = new AgentService(convSvc, stubFactory, fakeGraph as any);
      const tokens: string[] = [];
      for await (const t of svc.chatStream('bot-1', 42, 'hi')) {
        tokens.push(t);
      }

      expect(tokens).to.have.length(0);
    });

    it('completes cleanly with zero yields on an empty event stream', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      const fakeGraph = makeFakeGraph([]);

      const svc = new AgentService(convSvc, stubFactory, fakeGraph as any);
      const tokens: string[] = [];
      for await (const t of svc.chatStream('bot-1', 42, 'hi')) {
        tokens.push(t);
      }

      expect(tokens).to.have.length(0);
    });

    it('propagates errors thrown by the streamEvents generator', async () => {
      const AgentService = await buildAgentService();
      const convSvc = makeConvService();
      const { stubFactory } = makeModelFactory();

      async function* throwingGenerator() {
        yield { event: 'on_chat_model_stream', metadata: { langgraph_node: 'agent' }, data: { chunk: { content: 'before error' } } };
        throw new Error('stream failure');
      }

      const fakeGraph = {
        streamEvents: sinon.stub().returns(throwingGenerator()),
        invoke: sinon.stub().resolves({ messages: [] }),
      };

      const svc = new AgentService(convSvc, stubFactory, fakeGraph as any);

      let thrown: unknown;
      try {
        for await (const _t of svc.chatStream('bot-1', 42, 'hi')) { /* drain */ }
      } catch (err) {
        thrown = err;
      }

      expect(thrown).to.be.instanceOf(Error);
      expect((thrown as Error).message).to.equal('stream failure');
    });
  });
});
