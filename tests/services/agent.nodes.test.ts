/**
 * Direct unit tests for the exported node functions in agent.ts:
 *   checkBudgetRouter, summarizeNode, saveNode, agentNode, loadHistoryNode
 *
 * Uses esmock to mock llm-config (which calls readFileSync at load time) so
 * tests are hermetic and do not depend on llm.json or process.exit side-effects.
 */
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { AIMessage, HumanMessage, SystemMessage, RemoveMessage } from '@langchain/core/messages';

// ---------------------------------------------------------------------------
// Shared mock llmConfig — mirrors the shape expected by agent.ts
// ---------------------------------------------------------------------------

const mockLlmConfig = {
  chat: [
    { provider: 'openai',    model: 'gpt-4o',                    temperature: 0.7 },
    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', temperature: 0.7 },
  ],
  summarization: [
    { provider: 'openai',    model: 'gpt-4o-mini',               temperature: 0.3 },
    { provider: 'anthropic', model: 'claude-3-5-haiku-20241022',  temperature: 0.3 },
  ],
};

// ---------------------------------------------------------------------------
// Module loader — re-imports node functions with esmocked llm-config
// ---------------------------------------------------------------------------

async function loadAgentNodes(insertTokenUsageStub?: sinon.SinonStub, buildEphemeralContextStub?: sinon.SinonStub) {
  const module = await esmock('../../src/services/agent.js', {
    '../../src/config/llm-config.js': { llmConfig: mockLlmConfig },
    '../../src/db/queries/conversations.js': {
      setConversationSystemPrompt: sinon.stub().resolves(),
      clearConversation: sinon.stub().resolves(),
    },
    '../../src/db/queries/token-usage.js': {
      insertTokenUsage: insertTokenUsageStub ?? sinon.stub().resolves(),
    },
    '../../src/db/client.js': {
      pool: {},
    },
    '../../src/services/ephemeral-context/index.js': {
      buildEphemeralContext: buildEphemeralContextStub ?? sinon.stub().resolves(null),
      createDefaultPlugins: sinon.stub().returns([]),
    },
    '../../src/config/env.js': {
      env: {
        EPHEMERAL_CONTEXT_ENABLED: true,
        EPHEMERAL_CONTEXT_DATETIME_ENABLED: true,
        EPHEMERAL_CONTEXT_LOCALE_ENABLED: true,
        DATETIME_FORMAT: 'iso',
      },
    },
  });
  return {
    checkBudgetRouter: module.checkBudgetRouter as (state: any) => 'summarize' | 'save',
    summarizeNode: module.summarizeNode as (state: any, services: any) => Promise<any>,
    saveNode: module.saveNode as (state: any, services: any) => Promise<any>,
    agentNode: module.agentNode as (state: any, services: any) => Promise<any>,
    loadHistoryNode: module.loadHistoryNode as (state: any, services: any) => Promise<any>,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConvService(rowOverrides: Record<string, unknown> = {}) {
  return {
    load: sinon.stub().resolves({
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
      ...rowOverrides,
    }),
    save: sinon.stub().resolves(),
    clearMessages: sinon.stub().resolves(),
    resetForceSummarize: sinon.stub().resolves(),
  };
}

function makeModelFactory(reply = 'test reply') {
  const stubModel = { invoke: sinon.stub().resolves(new AIMessage(reply)) };
  const stubFactory = { create: sinon.stub().returns(stubModel) };
  return { stubModel, stubFactory };
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [] as (HumanMessage | AIMessage | SystemMessage | RemoveMessage)[],
    userInput: 'hello',
    summary: '',
    botId: 'testbot',
    userId: 123,
    systemPromptOverride: undefined,
    provider: 'openai',
    model: 'gpt-4o',
    summarizationProvider: 'openai',
    summarizationModel: 'gpt-4o-mini',
    forceSummarize: false,
    ...overrides,
  } as any;
}

// ===========================================================================
// T1+T2: checkBudgetRouter — direct unit tests
// ===========================================================================
// gpt-4o: maxTokens=128000, budget = Math.floor(128000 * 0.8) = 102400 tokens
// estimateTokens = Math.floor(totalChars / 4)
// Over budget:  totalChars / 4 > 102400  →  totalChars > 409600
// Under budget: totalChars / 4 < 102400  →  totalChars < 409600
// At boundary:  totalChars = 409600  → Math.floor(409600/4)=102400 === budget → NOT > → 'save'

describe('checkBudgetRouter', () => {
  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('routes to "save" when total tokens are well under budget', async () => {
    const { checkBudgetRouter } = await loadAgentNodes();
    // 10 messages × 100 chars = 1000 chars / 4 = 250 tokens  (budget=102400)
    const content = 'a'.repeat(100);
    const messages = Array.from({ length: 10 }, () => new HumanMessage(content));
    const state = makeState({ messages, model: 'gpt-4o' });

    const result = checkBudgetRouter(state);

    expect(result).to.equal('save');
  });

  it('routes to "summarize" when total tokens are well over budget', async () => {
    const { checkBudgetRouter } = await loadAgentNodes();
    // 1000 messages × 500 chars = 500000 chars / 4 = 125000 tokens > 102400
    const content = 'b'.repeat(500);
    const messages = Array.from({ length: 1000 }, () => new HumanMessage(content));
    const state = makeState({ messages, model: 'gpt-4o' });

    const result = checkBudgetRouter(state);

    expect(result).to.equal('summarize');
  });

  it('routes to "save" at exact boundary (strict > means equal goes to save)', async () => {
    const { checkBudgetRouter } = await loadAgentNodes();
    // Exactly budget * 4 = 102400 * 4 = 409600 chars
    // estimateTokens = Math.floor(409600 / 4) = 102400 === budget → NOT > budget → 'save'
    const content = 'c'.repeat(409600);
    const messages = [new HumanMessage(content)];
    const state = makeState({ messages, model: 'gpt-4o' });

    const result = checkBudgetRouter(state);

    expect(result).to.equal('save');
  });

  it('routes to "summarize" when clearly over boundary (one message with content exceeding budget)', async () => {
    const { checkBudgetRouter } = await loadAgentNodes();
    // 409601 chars / 4 = 102400.25 → floor = 102400... wait, need strictly over:
    // 409601 chars / 4 = 102400.25 → floor = 102400 which is NOT > 102400
    // Need 409604 chars → floor(409604/4) = 102401 > 102400 → 'summarize'
    const content = 'c'.repeat(409604);
    const messages = [new HumanMessage(content)];
    const state = makeState({ messages, model: 'gpt-4o' });

    const result = checkBudgetRouter(state);

    expect(result).to.equal('summarize');
  });

  it('falls back to FALLBACK_CONFIG (4096 maxTokens) for unknown model', async () => {
    const { checkBudgetRouter } = await loadAgentNodes();
    // Unknown model → budget = Math.floor(4096 * 0.8) = 3276 tokens
    // 1000 messages × 500 chars = 500000 chars / 4 = 125000 tokens >> 3276 → 'summarize'
    const content = 'd'.repeat(500);
    const messages = Array.from({ length: 1000 }, () => new HumanMessage(content));
    const state = makeState({ messages, model: 'unknown-model-xyz' });

    const result = checkBudgetRouter(state);

    expect(result).to.equal('summarize');
  });
});

// ===========================================================================
// T3 + T4: summarizeNode — direct unit tests
// ===========================================================================

describe('summarizeNode', () => {
  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // T4: Happy path
  it('returns summary text and RemoveMessage list for oldest half of messages', async () => {
    const { summarizeNode } = await loadAgentNodes();
    const { stubFactory } = makeModelFactory('This is the summary.');
    const state = makeState({
      messages: [
        new HumanMessage({ id: 'h1', content: 'message one' }),
        new AIMessage({ id: 'a1', content: 'reply one' }),
        new HumanMessage({ id: 'h2', content: 'message two' }),
        new AIMessage({ id: 'a2', content: 'reply two' }),
      ],
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
    });

    const result = await summarizeNode(state, { modelFactory: stubFactory });

    expect(result).to.have.property('summary', 'This is the summary.');
    expect(result).to.have.property('messages');
    const msgs = result.messages as RemoveMessage[];
    expect(msgs.length).to.be.greaterThan(0);
    msgs.forEach(m => expect(m).to.be.instanceOf(RemoveMessage));
  });

  it('only removes the oldest half of history messages', async () => {
    const { summarizeNode } = await loadAgentNodes();
    const { stubFactory } = makeModelFactory('summary');
    // 4 messages → oldest half = 2 → removes 2
    const state = makeState({
      messages: [
        new HumanMessage({ id: 'h1', content: 'msg1' }),
        new AIMessage({ id: 'a1', content: 'msg2' }),
        new HumanMessage({ id: 'h2', content: 'msg3' }),
        new AIMessage({ id: 'a2', content: 'msg4' }),
      ],
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
    });

    const result = await summarizeNode(state, { modelFactory: stubFactory });

    const removes = result.messages as RemoveMessage[];
    expect(removes).to.have.length(2);
  });

  // T4: Edge case — not enough messages (oldestHalfCount === 0)
  it('returns empty object when there is only 1 message (floor(1/2)=0, nothing to summarize)', async () => {
    const { summarizeNode } = await loadAgentNodes();
    const { stubFactory } = makeModelFactory('summary');
    const state = makeState({
      messages: [new HumanMessage({ id: 'h1', content: 'only one' })],
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
    });

    const result = await summarizeNode(state, { modelFactory: stubFactory });

    expect(result).to.deep.equal({});
  });

  it('returns empty object when messages is empty', async () => {
    const { summarizeNode } = await loadAgentNodes();
    const { stubFactory } = makeModelFactory('summary');
    const state = makeState({
      messages: [],
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
    });

    const result = await summarizeNode(state, { modelFactory: stubFactory });

    expect(result).to.deep.equal({});
  });

  // T4: Error path — modelFactory.create throws
  it('returns empty object (no throw) when modelFactory.create throws', async () => {
    const { summarizeNode } = await loadAgentNodes();
    const failFactory = {
      create: sinon.stub().throws(new Error('LLM unavailable')),
    };
    const state = makeState({
      messages: [
        new HumanMessage({ id: 'h1', content: 'msg1' }),
        new AIMessage({ id: 'a1', content: 'msg2' }),
      ],
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
    });

    const result = await summarizeNode(state, { modelFactory: failFactory });

    expect(result).to.deep.equal({});
  });

  // T4: Error path — model.invoke rejects
  it('returns empty object (no throw) when model.invoke rejects', async () => {
    const { summarizeNode } = await loadAgentNodes();
    const failModel = { invoke: sinon.stub().rejects(new Error('network error')) };
    const failFactory = { create: sinon.stub().returns(failModel) };
    const state = makeState({
      messages: [
        new HumanMessage({ id: 'h1', content: 'msg1' }),
        new AIMessage({ id: 'a1', content: 'msg2' }),
      ],
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
    });

    const result = await summarizeNode(state, { modelFactory: failFactory });

    expect(result).to.deep.equal({});
  });

  // T3: RemoveMessage ID bug — messages without explicit IDs produce no RemoveMessages
  it('produces zero RemoveMessages when messages have no explicit id (DB-loaded messages)', async () => {
    const { summarizeNode } = await loadAgentNodes();
    // Messages created without explicit id (as toBaseMessages() creates them from DB)
    const { stubFactory } = makeModelFactory('summary');
    const state = makeState({
      messages: [
        new HumanMessage('no id here'),   // id is undefined
        new AIMessage('no id either'),    // id is undefined
        new HumanMessage('still no id'),
        new AIMessage('still none'),
      ],
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
    });

    const result = await summarizeNode(state, { modelFactory: stubFactory });

    // summary is still set (summarization ran)
    expect(result).to.have.property('summary', 'summary');
    // but no RemoveMessages because m.id is undefined for all
    expect(result).to.have.property('messages');
    expect(result.messages).to.deep.equal([]);
  });

  // SystemMessage and sentinel AIMessage are excluded from history
  it('excludes SystemMessage from history when counting (1 SystemMsg + 1 HumanMsg → 0 to remove)', async () => {
    const { summarizeNode } = await loadAgentNodes();
    const { stubFactory } = makeModelFactory('summary');
    // 1 SystemMessage + 1 HumanMessage → historyMessages = [HumanMessage] → oldestHalfCount=0 → {}
    const state = makeState({
      messages: [
        new SystemMessage('You are helpful'),
        new HumanMessage({ id: 'h1', content: 'only user msg' }),
      ],
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
    });

    const result = await summarizeNode(state, { modelFactory: stubFactory });

    // historyMessages has 1 entry → floor(1/2) = 0 → returns {}
    expect(result).to.deep.equal({});
  });
});

// ===========================================================================
// T5: saveNode — direct unit tests
// ===========================================================================

describe('saveNode', () => {
  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  function makeSaveState() {
    return makeState({
      messages: [
        new SystemMessage('system prompt'),
        new AIMessage('Previous conversation summary:\nOld stuff.'), // sentinel
        new HumanMessage({ id: 'u1', content: 'user msg' }),
        new AIMessage({ id: 'a1', content: 'assistant reply' }),
      ],
      summary: 'current summary',
      botId: 'testbot',
      userId: 123,
    });
  }

  it('calls save with the correct botId and userId', async () => {
    const { saveNode } = await loadAgentNodes();
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    expect(convSvc.save.calledOnce).to.be.true;
    const [botId, userId] = convSvc.save.firstCall.args as [string, number, unknown, unknown];
    expect(botId).to.equal('testbot');
    expect(userId).to.equal(123);
  });

  it('does NOT include SystemMessage in the messages passed to save', async () => {
    const { saveNode } = await loadAgentNodes();
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    const [, , savedMessages] = convSvc.save.firstCall.args as [string, number, { role: string; content: string }[], unknown];
    const hasSystem = savedMessages.some(m => m.role === 'system');
    expect(hasSystem).to.be.false;
  });

  it('does NOT include the summary sentinel AIMessage in messages passed to save', async () => {
    const { saveNode } = await loadAgentNodes();
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    const [, , savedMessages] = convSvc.save.firstCall.args as [string, number, { role: string; content: string }[], unknown];
    const hasSentinel = savedMessages.some(m => m.content.startsWith('Previous conversation summary:'));
    expect(hasSentinel).to.be.false;
  });

  it('DOES include the user HumanMessage in messages passed to save', async () => {
    const { saveNode } = await loadAgentNodes();
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    const [, , savedMessages] = convSvc.save.firstCall.args as [string, number, { role: string; content: string }[], unknown];
    const hasUser = savedMessages.some(m => m.role === 'user' && m.content === 'user msg');
    expect(hasUser).to.be.true;
  });

  it('DOES include the assistant AIMessage in messages passed to save', async () => {
    const { saveNode } = await loadAgentNodes();
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    const [, , savedMessages] = convSvc.save.firstCall.args as [string, number, { role: string; content: string }[], unknown];
    const hasAssistant = savedMessages.some(m => m.role === 'assistant' && m.content === 'assistant reply');
    expect(hasAssistant).to.be.true;
  });

  it('passes state.summary as the fourth argument to save', async () => {
    const { saveNode } = await loadAgentNodes();
    const convSvc = makeConvService();
    const state = makeSaveState(); // summary: 'current summary'

    await saveNode(state, { conversationService: convSvc as any });

    const [, , , summary] = convSvc.save.firstCall.args as [string, number, unknown[], string | null];
    expect(summary).to.equal('current summary');
  });

  it('passes null to save when summary is empty string', async () => {
    const { saveNode } = await loadAgentNodes();
    const convSvc = makeConvService();
    const state = makeState({
      messages: [new HumanMessage('hi'), new AIMessage('hello')],
      summary: '', // empty → null
      botId: 'testbot',
      userId: 123,
    });

    await saveNode(state, { conversationService: convSvc as any });

    const [, , , summary] = convSvc.save.firstCall.args as [string, number, unknown[], string | null];
    expect(summary).to.be.null;
  });

  it('returns empty object', async () => {
    const { saveNode } = await loadAgentNodes();
    const convSvc = makeConvService();
    const state = makeSaveState();

    const result = await saveNode(state, { conversationService: convSvc as any });

    expect(result).to.deep.equal({});
  });

  // ── token usage fire-and-forget ────────────────────────────────────────────

  it('calls insertTokenUsage with usageType "chat" when chatUsage is present', async () => {
    const insertStub = sinon.stub().resolves();
    const { saveNode } = await loadAgentNodes(insertStub);
    const convSvc = makeConvService();
    const state = makeState({
      messages: [new HumanMessage('hi'), new AIMessage('hello')],
      summary: '',
      botId: 'testbot',
      userId: 123,
      provider: 'openai',
      model: 'gpt-4o',
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
      chatUsage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      summarizationUsage: null,
    });

    await saveNode(state, { conversationService: convSvc as any });
    // Flush microtask queue for fire-and-forget promises
    await Promise.resolve();
    await Promise.resolve();

    expect(insertStub.called).to.be.true;
    const callArgs = insertStub.getCalls().find(c => c.args[1]?.usageType === 'chat');
    expect(callArgs).to.exist;
    expect(callArgs!.args[1].usageType).to.equal('chat');
    expect(callArgs!.args[1].inputTokens).to.equal(10);
    expect(callArgs!.args[1].outputTokens).to.equal(20);
    expect(callArgs!.args[1].totalTokens).to.equal(30);
    expect(callArgs!.args[1]).to.include({ botId: 'testbot', telegramUserId: 123 });
  });

  it('calls insertTokenUsage with usageType "summarization" when summarizationUsage is present', async () => {
    const insertStub = sinon.stub().resolves();
    const { saveNode } = await loadAgentNodes(insertStub);
    const convSvc = makeConvService();
    const state = makeState({
      messages: [new HumanMessage('hi'), new AIMessage('hello')],
      summary: '',
      botId: 'testbot',
      userId: 123,
      provider: 'openai',
      model: 'gpt-4o',
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
      chatUsage: null,
      summarizationUsage: { input_tokens: 5, output_tokens: 15, total_tokens: 20 },
    });

    await saveNode(state, { conversationService: convSvc as any });
    await Promise.resolve();
    await Promise.resolve();

    expect(insertStub.called).to.be.true;
    const callArgs = insertStub.getCalls().find(c => c.args[1]?.usageType === 'summarization');
    expect(callArgs).to.exist;
    expect(callArgs!.args[1].usageType).to.equal('summarization');
    expect(callArgs!.args[1]).to.include({ botId: 'testbot', telegramUserId: 123 });
  });

  it('calls insertTokenUsage twice when both chatUsage and summarizationUsage are present', async () => {
    const insertStub = sinon.stub().resolves();
    const { saveNode } = await loadAgentNodes(insertStub);
    const convSvc = makeConvService();
    const state = makeState({
      messages: [new HumanMessage('hi'), new AIMessage('hello')],
      summary: '',
      botId: 'testbot',
      userId: 123,
      provider: 'openai',
      model: 'gpt-4o',
      summarizationProvider: 'openai',
      summarizationModel: 'gpt-4o-mini',
      chatUsage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      summarizationUsage: { input_tokens: 5, output_tokens: 15, total_tokens: 20 },
    });

    await saveNode(state, { conversationService: convSvc as any });
    await Promise.resolve();
    await Promise.resolve();

    expect(insertStub.callCount).to.equal(2);
    const usageTypes = insertStub.getCalls().map(c => c.args[1]?.usageType);
    expect(usageTypes).to.include('chat');
    expect(usageTypes).to.include('summarization');
    insertStub.getCalls().forEach(c => {
      expect(c.args[1]).to.include({ botId: 'testbot', telegramUserId: 123 });
    });
  });

  it('does not call insertTokenUsage when both chatUsage and summarizationUsage are null', async () => {
    const insertStub = sinon.stub().resolves();
    const { saveNode } = await loadAgentNodes(insertStub);
    const convSvc = makeConvService();
    const state = makeState({
      messages: [new HumanMessage('hi'), new AIMessage('hello')],
      summary: '',
      botId: 'testbot',
      userId: 123,
      chatUsage: null,
      summarizationUsage: null,
    });

    await saveNode(state, { conversationService: convSvc as any });
    await Promise.resolve();
    await Promise.resolve();

    expect(insertStub.called).to.be.false;
  });

  it('saveNode still resolves when insertTokenUsage rejects (error swallowed)', async () => {
    const insertStub = sinon.stub().rejects(new Error('DB write failed'));
    const { saveNode } = await loadAgentNodes(insertStub);
    const convSvc = makeConvService();
    const state = makeState({
      messages: [new HumanMessage('hi'), new AIMessage('hello')],
      summary: '',
      botId: 'testbot',
      userId: 123,
      chatUsage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      summarizationUsage: null,
    });

    // Must not throw
    const result = await saveNode(state, { conversationService: convSvc as any });
    await Promise.resolve();
    await Promise.resolve();

    expect(result).to.deep.equal({});
  });
});

// ===========================================================================
// T6: agentNode — direct unit tests
// ===========================================================================

describe('agentNode', () => {
  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('returns object with messages array containing the AI reply', async () => {
    const { agentNode } = await loadAgentNodes();
    const { stubFactory } = makeModelFactory('LLM reply');
    const state = makeState({
      messages: [new HumanMessage('hello')],
      provider: 'openai',
      model: 'gpt-4o',
    });

    const result = await agentNode(state, { modelFactory: stubFactory });

    expect(result).to.have.property('messages');
    const msgs = result.messages as AIMessage[];
    expect(msgs).to.have.length(1);
    expect(msgs[0]).to.be.instanceOf(AIMessage);
    expect(msgs[0].content).to.equal('LLM reply');
  });

  it('calls modelFactory.create with provider and model from the first llmConfig.chat slot', async () => {
    const { agentNode } = await loadAgentNodes();
    const { stubFactory } = makeModelFactory('reply');
    const state = makeState({
      messages: [new HumanMessage('test')],
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
    });

    await agentNode(state, { modelFactory: stubFactory });

    // New loop-based agentNode uses llmConfig.chat[0] (openai/gpt-4o), not state values
    expect(stubFactory.create.calledOnceWith('openai', 'gpt-4o')).to.be.true;
  });

  it('calls model.invoke with the full state.messages array', async () => {
    const { agentNode } = await loadAgentNodes();
    const { stubModel, stubFactory } = makeModelFactory('reply');
    const inputMessages = [
      new SystemMessage('be helpful'),
      new HumanMessage('question'),
    ];
    const state = makeState({ messages: inputMessages, provider: 'openai', model: 'gpt-4o' });

    await agentNode(state, { modelFactory: stubFactory });

    expect(stubModel.invoke.calledOnce).to.be.true;
    const [invokeArgs] = stubModel.invoke.firstCall.args as [unknown[]];
    expect(invokeArgs).to.deep.equal(inputMessages);
  });

  // ── Ephemeral context integration ──────────────────────────────────────────

  it('calls model.invoke with state.messages unchanged when ephemeralPlugins is empty', async () => {
    const ephemeralStub = sinon.stub().resolves(null);
    const { agentNode } = await loadAgentNodes(undefined, ephemeralStub);
    const { stubModel, stubFactory } = makeModelFactory('reply');
    const inputMessages = [new HumanMessage('hello')];
    const state = makeState({ messages: inputMessages });

    await agentNode(state, { modelFactory: stubFactory, ephemeralPlugins: [] });

    const [invokeArgs] = stubModel.invoke.firstCall.args as [unknown[]];
    expect(invokeArgs).to.have.length(1);
    expect(invokeArgs[0]).to.be.instanceOf(HumanMessage);
  });

  it('inserts ephemeral SystemMessage one above user message when plugin returns content', async () => {
    const { SystemMessage: SM } = await import('@langchain/core/messages');
    const fakeEphemeralMsg = new SM('[Context]\nCurrent UTC date and time: 2024-01-15T10:00:00.000Z');
    const ephemeralStub = sinon.stub().resolves(fakeEphemeralMsg);
    const { agentNode } = await loadAgentNodes(undefined, ephemeralStub);
    const { stubModel, stubFactory } = makeModelFactory('reply');
    const inputMessages = [new HumanMessage('hi')];
    const state = makeState({ messages: inputMessages });

    await agentNode(state, { modelFactory: stubFactory, ephemeralPlugins: [] });

    const [invokeArgs] = stubModel.invoke.firstCall.args as [unknown[]];
    expect(invokeArgs).to.have.length(2);
    expect(invokeArgs[invokeArgs.length - 2]).to.be.instanceOf(SM);
    expect((invokeArgs[invokeArgs.length - 2] as InstanceType<typeof SM>).content).to.include('[Context]');
    expect(invokeArgs[invokeArgs.length - 1]).to.be.instanceOf(HumanMessage);
  });

  it('does NOT mutate state.messages after agentNode runs', async () => {
    const fakeEphemeralMsg = new SystemMessage('[Context]\nsome context');
    const ephemeralStub = sinon.stub().resolves(fakeEphemeralMsg);
    const { agentNode } = await loadAgentNodes(undefined, ephemeralStub);
    const { stubFactory } = makeModelFactory('reply');
    const inputMessages = [new HumanMessage('hi')];
    const state = makeState({ messages: inputMessages });
    const originalLength = state.messages.length;
    const originalRef = state.messages;

    await agentNode(state, { modelFactory: stubFactory, ephemeralPlugins: [] });

    expect(state.messages).to.equal(originalRef); // same reference
    expect(state.messages).to.have.length(originalLength); // same length
  });

  it('still calls model.invoke when ephemeral plugin rejects', async () => {
    // buildEphemeralContext swallows errors and returns null — model.invoke still called
    const ephemeralStub = sinon.stub().resolves(null); // simulates all-plugins-rejected case
    const { agentNode } = await loadAgentNodes(undefined, ephemeralStub);
    const { stubModel, stubFactory } = makeModelFactory('reply');
    const inputMessages = [new HumanMessage('hello')];
    const state = makeState({ messages: inputMessages });

    await agentNode(state, { modelFactory: stubFactory, ephemeralPlugins: [] });

    expect(stubModel.invoke.calledOnce).to.be.true;
    const [invokeArgs] = stubModel.invoke.firstCall.args as [unknown[]];
    // Only the original messages — no ephemeral message appended
    expect(invokeArgs).to.deep.equal(inputMessages);
  });

  it('passes only projected toolsetState fields (timezone, locale) to buildEphemeralContext', async () => {
    const ephemeralStub = sinon.stub().resolves(null);
    const { agentNode } = await loadAgentNodes(undefined, ephemeralStub);
    const { stubFactory } = makeModelFactory('reply');
    const state = makeState({
      messages: [new HumanMessage('hi')],
      toolsetState: { timezone: 'Asia/Tokyo', email: 'secret@example.com', email_verified: true },
    });

    await agentNode(state, { modelFactory: stubFactory, ephemeralPlugins: [] });

    expect(ephemeralStub.calledOnce).to.be.true;
    const ephemeralInput = ephemeralStub.firstCall.args[1];
    // After B3 projection: only timezone and locale are forwarded (locale is undefined here)
    expect(ephemeralInput.toolsetState.timezone).to.equal('Asia/Tokyo');
    // PII fields must NOT be forwarded
    expect(ephemeralInput.toolsetState).to.not.have.property('email');
    expect(ephemeralInput.toolsetState).to.not.have.property('email_verified');
  });

  it('threads env with EPHEMERAL_CONTEXT_ENABLED:false through to buildEphemeralContext', async () => {
    // Load agentNode with EPHEMERAL_CONTEXT_ENABLED: false in the mocked env
    const ephemeralStub = sinon.stub().resolves(null);
    const module = await esmock('../../src/services/agent.js', {
      '../../src/config/llm-config.js': { llmConfig: mockLlmConfig },
      '../../src/db/queries/conversations.js': {
        setConversationSystemPrompt: sinon.stub().resolves(),
        clearConversation: sinon.stub().resolves(),
      },
      '../../src/db/queries/token-usage.js': { insertTokenUsage: sinon.stub().resolves() },
      '../../src/db/client.js': { pool: {} },
      '../../src/services/ephemeral-context/index.js': {
        buildEphemeralContext: ephemeralStub,
        createDefaultPlugins: sinon.stub().returns([]),
      },
      '../../src/config/env.js': {
        env: {
          EPHEMERAL_CONTEXT_ENABLED: false,
          EPHEMERAL_CONTEXT_DATETIME_ENABLED: false,
          EPHEMERAL_CONTEXT_LOCALE_ENABLED: false,
          DATETIME_FORMAT: 'iso',
        },
      },
    });
    const agentNodeFn = module.agentNode as (state: any, services: any) => Promise<any>;
    const { stubModel, stubFactory } = makeModelFactory('reply');
    const inputMessages = [new HumanMessage('hello')];
    const state = makeState({ messages: inputMessages });

    await agentNodeFn(state, { modelFactory: stubFactory, ephemeralPlugins: [] });

    // buildEphemeralContext was called with the env that has the flag false
    expect(ephemeralStub.calledOnce).to.be.true;
    const passedEnv = ephemeralStub.firstCall.args[2];
    expect(passedEnv.EPHEMERAL_CONTEXT_ENABLED).to.be.false;

    // model.invoke was called with exactly the original messages (no ephemeral SystemMessage)
    expect(stubModel.invoke.calledOnce).to.be.true;
    const [invokeArgs] = stubModel.invoke.firstCall.args as [unknown[]];
    expect(invokeArgs).to.deep.equal(inputMessages);
  });
});

// ===========================================================================
// T7: loadHistoryNode — direct unit tests
// ===========================================================================

describe('loadHistoryNode', () => {
  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('uses system_prompt from DB row as first SystemMessage when no override', async () => {
    const { loadHistoryNode } = await loadAgentNodes();
    const convSvc = makeConvService({ system_prompt: 'sys from db', summary: null });
    const state = makeState({ userInput: 'hi', systemPromptOverride: undefined });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as SystemMessage[];
    expect(msgs[0]).to.be.instanceOf(SystemMessage);
    expect(msgs[0].content).to.equal('sys from db');
  });

  it('uses systemPromptOverride instead of row.system_prompt when override provided', async () => {
    const { loadHistoryNode } = await loadAgentNodes();
    const convSvc = makeConvService({ system_prompt: 'original', summary: null });
    const state = makeState({ userInput: 'hi', systemPromptOverride: 'override prompt' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as SystemMessage[];
    expect(msgs[0]).to.be.instanceOf(SystemMessage);
    expect(msgs[0].content).to.equal('override prompt');
  });

  it('injects summary AIMessage when row.summary is non-empty', async () => {
    const { loadHistoryNode } = await loadAgentNodes();
    const convSvc = makeConvService({ system_prompt: null, summary: 'some summary' });
    const state = makeState({ userInput: 'hi', systemPromptOverride: undefined });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as (HumanMessage | AIMessage)[];
    const summaryMsg = msgs.find(m => m instanceof AIMessage && String(m.content).includes('some summary'));
    expect(summaryMsg).to.exist;
  });

  it('does NOT inject summary AIMessage when row.summary is null', async () => {
    const { loadHistoryNode } = await loadAgentNodes();
    const convSvc = makeConvService({ system_prompt: null, summary: null });
    const state = makeState({ userInput: 'hi' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as (HumanMessage | AIMessage)[];
    const summaryMsg = msgs.find(m => m instanceof AIMessage && String(m.content).startsWith('Previous conversation summary:'));
    expect(summaryMsg).to.not.exist;
  });

  it('does NOT inject summary AIMessage when row.summary is empty string', async () => {
    const { loadHistoryNode } = await loadAgentNodes();
    const convSvc = makeConvService({ system_prompt: null, summary: '' });
    const state = makeState({ userInput: 'hi' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as (HumanMessage | AIMessage)[];
    const summaryMsg = msgs.find(m => m instanceof AIMessage && String(m.content).startsWith('Previous conversation summary:'));
    expect(summaryMsg).to.not.exist;
  });

  it('appends state.userInput as the LAST HumanMessage in returned messages', async () => {
    const { loadHistoryNode } = await loadAgentNodes();
    const convSvc = makeConvService({
      system_prompt: null,
      summary: null,
      messages: [{ role: 'user', content: 'old message' }],
    });
    const state = makeState({ userInput: 'newest user input' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as (HumanMessage | AIMessage)[];
    const last = msgs[msgs.length - 1];
    expect(last).to.be.instanceOf(HumanMessage);
    expect(last.content).to.equal('newest user input');
  });

  it('returns [HumanMessage(userInput)] when row.messages is empty and no system/summary', async () => {
    const { loadHistoryNode } = await loadAgentNodes();
    const convSvc = makeConvService({ system_prompt: null, summary: null, messages: [] });
    const state = makeState({ userInput: 'only message' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as HumanMessage[];
    expect(msgs).to.have.length(1);
    expect(msgs[0]).to.be.instanceOf(HumanMessage);
    expect(msgs[0].content).to.equal('only message');
  });

  it('places [SystemMessage, HumanMessage(userInput)] when system_prompt set and no history', async () => {
    const { loadHistoryNode } = await loadAgentNodes();
    const convSvc = makeConvService({ system_prompt: 'be helpful', summary: null, messages: [] });
    const state = makeState({ userInput: 'hello' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as (SystemMessage | HumanMessage)[];
    expect(msgs).to.have.length(2);
    expect(msgs[0]).to.be.instanceOf(SystemMessage);
    expect(msgs[1]).to.be.instanceOf(HumanMessage);
    expect(msgs[1].content).to.equal('hello');
  });

  it('returns provider and model fields from mockLlmConfig (not DB row)', async () => {
    const { loadHistoryNode } = await loadAgentNodes();
    const convSvc = makeConvService({
      // DB row has stale/different values — llmConfig should take precedence
      llm_provider: 'anthropic',
      llm_model: 'claude-3-5-sonnet-20241022',
      summarization_provider: 'anthropic',
      summarization_model: 'claude-3-5-haiku-20241022',
      system_prompt: null,
      summary: null,
    });
    const state = makeState({ userInput: 'hi' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    // Values come from mockLlmConfig, not the DB row
    expect(result.provider).to.equal(mockLlmConfig.chat[0]!.provider);
    expect(result.model).to.equal(mockLlmConfig.chat[0]!.model);
    expect(result.summarizationProvider).to.equal(mockLlmConfig.summarization[0]!.provider);
    expect(result.summarizationModel).to.equal(mockLlmConfig.summarization[0]!.model);
  });
});
