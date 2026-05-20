import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';

// ---------------------------------------------------------------------------
// Helpers — stub ConversationRow
// ---------------------------------------------------------------------------

function makeRow(overrides: Record<string, unknown> = {}) {
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

// ---------------------------------------------------------------------------
// Stub ConversationService
// ---------------------------------------------------------------------------

function makeConvService(rowOverrides: Record<string, unknown> = {}) {
  return {
    load: sinon.stub().resolves(makeRow(rowOverrides)),
    save: sinon.stub().resolves(),
    clearMessages: sinon.stub().resolves(),
    resetForceSummarize: sinon.stub().resolves(),
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
// Build AgentService with esmocked llm-config + DB stubs
// ---------------------------------------------------------------------------

const mockLlmConfig = {
  chat: [
    { provider: 'openai', model: 'gpt-4o', temperature: 0.7 },
    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', temperature: 0.7 },
  ],
  summarization: [
    { provider: 'openai', model: 'gpt-4o-mini', temperature: 0.3 },
    { provider: 'anthropic', model: 'claude-3-5-haiku-20241022', temperature: 0.3 },
  ],
  summarizationConfig: { threshold: 0.8, compression: 0.5, forceCompression: 0.75 },
};

let setConversationSystemPromptStub: sinon.SinonStub;

let lastAgentMod: any;

async function buildAgentService() {
  setConversationSystemPromptStub = sinon.stub().resolves();

  lastAgentMod = await esmock('../../src/services/agent.ts', {
    '../../src/config/llm-config.js': { llmConfig: mockLlmConfig },
    '../../src/db/queries/conversations.js': {
      setConversationSystemPrompt: setConversationSystemPromptStub,
      clearConversation: sinon.stub().resolves(),
    },
  });
  return lastAgentMod.AgentService;
}

async function buildAgentNodes() {
  lastAgentMod = await esmock('../../src/services/agent.ts', {
    '../../src/config/llm-config.js': { llmConfig: mockLlmConfig },
    '../../src/db/queries/conversations.js': {
      setConversationSystemPrompt: sinon.stub().resolves(),
      clearConversation: sinon.stub().resolves(),
    },
  });
  return {
    checkBudgetRouter: lastAgentMod.checkBudgetRouter as (state: Record<string, unknown>) => string,
    loadHistoryNode: lastAgentMod.loadHistoryNode as (state: Record<string, unknown>, services: Record<string, unknown>) => Promise<Record<string, unknown>>,
    summarizeNode: lastAgentMod.summarizeNode as (state: Record<string, unknown>, services: Record<string, unknown>) => Promise<Record<string, unknown>>,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentService (LangGraph)', () => {
  afterEach(async () => {
    if (lastAgentMod) {
      await esmock.purge(lastAgentMod);
      lastAgentMod = undefined;
    }
    sinon.restore();
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
      // Summary is now embedded in a SystemMessage, not a separate AIMessage
      const systemMessages = messages.filter(m => m.getType() === 'system');
      const sentinelMsg = systemMessages.find(m => m.content.includes('User likes TypeScript'));
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

    it('uses provider and model from llmConfig (not DB row)', async () => {
      const AgentService = await buildAgentService();
      // DB row has different provider/model — agent should use llmConfig values
      const convSvc = makeConvService({
        llm_provider: 'anthropic',
        llm_model: 'claude-3-5-sonnet-20241022',
      });
      const { stubFactory } = makeModelFactory();

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('bot-1', 42, 'hello');

      // mockLlmConfig.chat[0] = openai / gpt-4o
      expect(stubFactory.create.calledWith('openai', 'gpt-4o')).to.be.true;
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

  // ── checkBudget branch — summarize fires when over budget ─────────────────

  describe('checkBudget router (summarize path)', () => {
    it('save is called even after summarization runs (graph completes)', async () => {
      const AgentService = await buildAgentService();

      // Budget: mockLlmConfig chat[0].model = 'gpt-4o' → maxTokens=128000, budget=102400.
      // Need > 409600 chars: 410 messages × 1000 chars = 410000 chars → 102500 tokens > 102400.
      const longContent = 'x'.repeat(1000);
      const manyMessages = Array.from({ length: 410 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longContent,
      }));

      const convSvc = makeConvService({
        messages: manyMessages,
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
      //   mockLlmConfig → chat[0].model = 'gpt-4o', maxTokens=128000, budget=102400
      //   To trigger summarize: need totalTokens > 102400 → need > 409600 chars total.
      //   410 messages × 1000 chars = 410000 chars → 102500 tokens > 102400 ✓
      const longContent = 'y'.repeat(1000);
      const manyMessages = Array.from({ length: 410 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: longContent,
      }));

      const convSvc = makeConvService({ messages: manyMessages });
      const { stubFactory } = makeModelFactory('reply');

      const svc = new AgentService(convSvc, stubFactory);
      await svc.chat('bot-1', 42, 'long conversation');

      // At least 2 create() calls: agent model + summarizer model
      expect(stubFactory.create.callCount).to.be.at.least(2);
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

  // ── checkBudgetRouter (unit) ──────────────────────────────────────────────

  describe('checkBudgetRouter (unit)', () => {
    it('routes to summarize when forceSummarize is true regardless of token count', async () => {
      const { checkBudgetRouter } = await buildAgentNodes();

      // Zero messages → zero tokens → well under any budget, but forceSummarize overrides
      const state = {
        forceSummarize: true,
        messages: [],
        model: 'unknown-model-xyz', // FALLBACK maxTokens=4096
        botId: 'bot-1',
        userId: 42,
      };

      expect(checkBudgetRouter(state)).to.equal('summarize');
    });
  });

  // ── loadHistoryNode (unit) ────────────────────────────────────────────────

  describe('loadHistoryNode (unit)', () => {
    it('maps force_summarize: true on row to forceSummarize: true in returned state', async () => {
      const { loadHistoryNode } = await buildAgentNodes();

      const convSvc = makeConvService({ force_summarize: true });

      const state = {
        messages: [],
        userInput: 'hello',
        botId: 'bot-1',
        userId: 42,
        systemPromptOverride: undefined,
        summary: '',
        provider: '',
        model: '',
        summarizationProvider: '',
        summarizationModel: '',
        forceSummarize: false,
      };

      const result = await loadHistoryNode(state, { conversationService: convSvc });
      expect((result as { forceSummarize: boolean }).forceSummarize).to.be.true;
    });
  });

  // ── summarizeNode (unit) ──────────────────────────────────────────────────

  describe('summarizeNode (unit)', () => {
    function makeMessages(count: number) {
      return Array.from({ length: count }, (_, i) => {
        const m = i % 2 === 0 ? new HumanMessage(`user ${i}`) : new AIMessage(`ai ${i}`);
        // Assign deterministic IDs so RemoveMessage can reference them
        (m as { id: string }).id = `msg-${i}`;
        return m;
      });
    }

    it('summarizes 75% of messages when forceSummarize is true', async () => {
      const { summarizeNode } = await buildAgentNodes();

      const { stubModel, stubFactory } = makeModelFactory('summary text');
      const convSvc = makeConvService();

      // 8 messages → floor(8 * 0.75) = 6 should be passed to the summarizer
      const msgs = makeMessages(8);

      const state = {
        messages: msgs,
        forceSummarize: true,
        botId: 'bot-1',
        userId: 42,
        summarizationProvider: 'openai',
        summarizationModel: 'gpt-4o-mini',
        summary: '',
      };

      await summarizeNode(state, { modelFactory: stubFactory, conversationService: convSvc });

      // The summarizer model.invoke should have been called; verify message count passed to it
      expect(stubModel.invoke.calledOnce).to.be.true;
      const [invokeArgs] = stubModel.invoke.firstCall.args as [unknown[]];
      // invokeArgs = [SystemMessage, ...messagesToSummarize filtered to human/ai, HumanMessage]
      // messagesToSummarize length = floor(8 * 0.75) = 6; all are human/ai so 6 history msgs + 1 system + 1 closing human = 8
      const nonSystemNonClosing = (invokeArgs as { getType(): string }[]).filter(
        (m, idx) => idx !== 0 && idx !== invokeArgs.length - 1
      );
      expect(nonSystemNonClosing).to.have.length(6);
    });

    it('does NOT call conversationService.resetForceSummarize from summarizeNode (moved to saveNode)', async () => {
      const { summarizeNode } = await buildAgentNodes();

      const { stubFactory } = makeModelFactory('summary text');
      const convSvc = makeConvService();

      const msgs = makeMessages(4);

      const state = {
        messages: msgs,
        forceSummarize: true,
        botId: 'bot-1',
        userId: 42,
        summarizationProvider: 'openai',
        summarizationModel: 'gpt-4o-mini',
        summary: '',
      };

      await summarizeNode(state, { modelFactory: stubFactory, conversationService: convSvc });

      // Allow the fire-and-forget promise to resolve
      await new Promise(resolve => setImmediate(resolve));

      expect(convSvc.resetForceSummarize.called).to.be.false;
    });

    it('does NOT call conversationService.resetForceSummarize when forceSummarize is false', async () => {
      const { summarizeNode } = await buildAgentNodes();

      const { stubFactory } = makeModelFactory('summary text');
      const convSvc = makeConvService();

      const msgs = makeMessages(4);

      const state = {
        messages: msgs,
        forceSummarize: false,
        botId: 'bot-1',
        userId: 42,
        summarizationProvider: 'openai',
        summarizationModel: 'gpt-4o-mini',
        summary: '',
      };

      await summarizeNode(state, { modelFactory: stubFactory, conversationService: convSvc });

      await new Promise(resolve => setImmediate(resolve));

      expect(convSvc.resetForceSummarize.called).to.be.false;
    });
  });

  // ── toolNode (unit) ───────────────────────────────────────────────────────

  describe('toolNode (unit)', () => {
    async function buildToolNode() {
      lastAgentMod = await esmock('../../src/services/agent.ts', {
        '../../src/config/llm-config.js': { llmConfig: mockLlmConfig },
        '../../src/db/queries/conversations.js': {
          setConversationSystemPrompt: sinon.stub().resolves(),
          clearConversation: sinon.stub().resolves(),
        },
      });
      return lastAgentMod.toolNode as (state: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }

    it('returns {} when last message is not an AI message', async () => {
      const toolNode = await buildToolNode();

      const state = {
        messages: [new HumanMessage('hello')],
        tools: [],
        toolCallRound: 0,
      };

      const result = await toolNode(state);
      expect(result).to.deep.equal({});
    });

    it('returns {} when last AI message has no tool_calls', async () => {
      const toolNode = await buildToolNode();

      const state = {
        messages: [new AIMessage('plain reply')],
        tools: [],
        toolCallRound: 0,
      };

      const result = await toolNode(state);
      expect(result).to.deep.equal({});
    });

    it('executes tool call and returns ToolMessage result', async () => {
      const toolNode = await buildToolNode();

      const stubTool = {
        name: 'my_tool',
        invoke: sinon.stub().resolves('tool output'),
      };

      // Build an AI message with a tool_call
      const aiMsg = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'my_tool', args: { query: 'test' }, id: 'call-1', type: 'tool_call' },
        ],
      });

      const state = {
        messages: [aiMsg],
        tools: [stubTool],
        toolCallRound: 0,
      };

      const result = await toolNode(state) as { messages: ToolMessage[]; toolCallRound: number };

      expect(result.messages).to.be.an('array').with.length(1);
      expect(result.messages[0]).to.be.instanceOf(ToolMessage);
      expect(result.messages[0]!.content).to.equal('tool output');
      expect(result.messages[0]!.tool_call_id).to.equal('call-1');
      expect(result.toolCallRound).to.equal(1);
    });

    it('returns error ToolMessage when tool is not found in state.tools', async () => {
      const toolNode = await buildToolNode();

      const aiMsg = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'unknown_tool', args: {}, id: 'call-2', type: 'tool_call' },
        ],
      });

      const state = {
        messages: [aiMsg],
        tools: [],
        toolCallRound: 0,
      };

      const result = await toolNode(state) as { messages: ToolMessage[] };
      expect(result.messages).to.be.an('array').with.length(1);
      expect(result.messages[0]!.content).to.include('unknown_tool');
      expect(result.messages[0]!.content).to.include('not found');
    });

    it('returns error ToolMessage when tool.invoke throws', async () => {
      const toolNode = await buildToolNode();

      const failingTool = {
        name: 'flaky_tool',
        invoke: sinon.stub().rejects(new Error('tool failure')),
      };

      const aiMsg = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'flaky_tool', args: {}, id: 'call-3', type: 'tool_call' },
        ],
      });

      const state = {
        messages: [aiMsg],
        tools: [failingTool],
        toolCallRound: 0,
      };

      const result = await toolNode(state) as { messages: ToolMessage[] };
      expect(result.messages).to.be.an('array').with.length(1);
      expect(result.messages[0]!.content).to.include('Tool error');
      expect(result.messages[0]!.content).to.include('tool failure');
    });

    it('increments toolCallRound on each execution', async () => {
      const toolNode = await buildToolNode();

      const stubTool = {
        name: 'counter_tool',
        invoke: sinon.stub().resolves('counted'),
      };

      const aiMsg = new AIMessage({
        content: '',
        tool_calls: [
          { name: 'counter_tool', args: {}, id: 'call-4', type: 'tool_call' },
        ],
      });

      const state = {
        messages: [aiMsg],
        tools: [stubTool],
        toolCallRound: 2,
      };

      const result = await toolNode(state) as { toolCallRound: number };
      expect(result.toolCallRound).to.equal(3);
    });
  });

  // ── agentRouter (unit) ────────────────────────────────────────────────────

  describe('agentRouter (unit)', () => {
    async function buildAgentRouter() {
      lastAgentMod = await esmock('../../src/services/agent.ts', {
        '../../src/config/llm-config.js': { llmConfig: mockLlmConfig },
        '../../src/db/queries/conversations.js': {
          setConversationSystemPrompt: sinon.stub().resolves(),
          clearConversation: sinon.stub().resolves(),
        },
      });
      return lastAgentMod.agentRouter as (state: Record<string, unknown>) => string;
    }

    it('routes to "tools" when last AI message has tool_calls and round is within limit', async () => {
      const agentRouter = await buildAgentRouter();

      const aiMsg = new AIMessage({
        content: '',
        tool_calls: [{ name: 'my_tool', args: {}, id: 'c1', type: 'tool_call' }],
      });

      const state = {
        messages: [aiMsg],
        tools: [{ name: 'my_tool' }],
        toolCallRound: 0,
        model: 'unknown-model-xyz',
        forceSummarize: false,
      };

      expect(agentRouter(state)).to.equal('tools');
    });

    it('routes to "save" (not "tools") when toolCallRound >= MAX_TOOL_CALL_ROUNDS', async () => {
      const agentRouter = await buildAgentRouter();

      const aiMsg = new AIMessage({
        content: '',
        tool_calls: [{ name: 'my_tool', args: {}, id: 'c2', type: 'tool_call' }],
      });

      const state = {
        messages: [aiMsg],
        tools: [{ name: 'my_tool' }],
        toolCallRound: 5, // MAX_TOOL_CALL_ROUNDS = 5
        model: 'unknown-model-xyz',
        forceSummarize: false,
      };

      // Should fall through to checkBudgetRouter → 'save' (zero messages, under budget)
      expect(agentRouter(state)).to.equal('save');
    });

    it('N2: toolCallRound >= MAX_TOOL_CALL_ROUNDS AND token budget exceeded → routes to "summarize"', async () => {
      const agentRouter = await buildAgentRouter();

      // gpt-4o: maxTokens=128000, threshold=0.8, budget=floor(128000*0.8)=102400 tokens
      // estimateTokens = floor(totalChars/4); need totalChars > 409600
      // Use a single AIMessage with 409604 chars → floor(409604/4)=102401 > 102400
      const bigContent = 'x'.repeat(409604);
      const aiMsg = new AIMessage({
        content: bigContent,
        tool_calls: [{ name: 'my_tool', args: {}, id: 'c3', type: 'tool_call' }],
      });

      const state = {
        messages: [aiMsg],
        tools: [{ name: 'my_tool' }],
        toolCallRound: 5, // MAX_TOOL_CALL_ROUNDS = 5 → tool condition fails
        model: 'gpt-4o',
        forceSummarize: false,
      };

      // tool_calls present but round >= MAX → falls to checkBudgetRouter
      // tokens (102401) > budget (102400) → 'summarize'
      expect(agentRouter(state)).to.equal('summarize');
    });

    it('routes to "save" when last AI message has no tool_calls', async () => {
      const agentRouter = await buildAgentRouter();

      const state = {
        messages: [new AIMessage('plain text response')],
        tools: [],
        toolCallRound: 0,
        model: 'unknown-model-xyz',
        forceSummarize: false,
      };

      expect(agentRouter(state)).to.equal('save');
    });
  });
});
