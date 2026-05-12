/**
 * Direct unit tests for the exported node functions in agent.ts:
 *   checkBudgetRouter, summarizeNode, saveNode, agentNode, loadHistoryNode
 *
 * These tests import the real module (no esmock) so pure-function behaviour
 * is tested against the real getModelConfig / estimateTokens implementations.
 */
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AIMessage, HumanMessage, SystemMessage, RemoveMessage } from '@langchain/core/messages';
import {
  checkBudgetRouter,
  summarizeNode,
  saveNode,
  agentNode,
  loadHistoryNode,
} from '../../src/services/agent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConvService(rowOverrides: Record<string, unknown> = {}) {
  return {
    load: sinon.stub().resolves({
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
      ...rowOverrides,
    }),
    save: sinon.stub().resolves(),
    clearMessages: sinon.stub().resolves(),
    updateProvider: sinon.stub().resolves(),
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
  afterEach(() => sinon.restore());

  it('routes to "save" when total tokens are well under budget', () => {
    // 10 messages × 100 chars = 1000 chars / 4 = 250 tokens  (budget=102400)
    const content = 'a'.repeat(100);
    const messages = Array.from({ length: 10 }, () => new HumanMessage(content));
    const state = makeState({ messages, model: 'gpt-4o' });

    const result = checkBudgetRouter(state);

    expect(result).to.equal('save');
  });

  it('routes to "summarize" when total tokens are well over budget', () => {
    // 1000 messages × 500 chars = 500000 chars / 4 = 125000 tokens > 102400
    const content = 'b'.repeat(500);
    const messages = Array.from({ length: 1000 }, () => new HumanMessage(content));
    const state = makeState({ messages, model: 'gpt-4o' });

    const result = checkBudgetRouter(state);

    expect(result).to.equal('summarize');
  });

  it('routes to "save" at exact boundary (strict > means equal goes to save)', () => {
    // Exactly budget * 4 = 102400 * 4 = 409600 chars
    // estimateTokens = Math.floor(409600 / 4) = 102400 === budget → NOT > budget → 'save'
    const content = 'c'.repeat(409600);
    const messages = [new HumanMessage(content)];
    const state = makeState({ messages, model: 'gpt-4o' });

    const result = checkBudgetRouter(state);

    expect(result).to.equal('save');
  });

  it('routes to "summarize" when clearly over boundary (one message with content exceeding budget)', () => {
    // 409601 chars / 4 = 102400.25 → floor = 102400... wait, need strictly over:
    // 409601 chars / 4 = 102400.25 → floor = 102400 which is NOT > 102400
    // Need 409604 chars → floor(409604/4) = 102401 > 102400 → 'summarize'
    const content = 'c'.repeat(409604);
    const messages = [new HumanMessage(content)];
    const state = makeState({ messages, model: 'gpt-4o' });

    const result = checkBudgetRouter(state);

    expect(result).to.equal('summarize');
  });

  it('falls back to FALLBACK_CONFIG (4096 maxTokens) for unknown model', () => {
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
  afterEach(() => sinon.restore());

  // T4: Happy path
  it('returns summary text and RemoveMessage list for oldest half of messages', async () => {
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
  afterEach(() => sinon.restore());

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
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    expect(convSvc.save.calledOnce).to.be.true;
    const [botId, userId] = convSvc.save.firstCall.args as [string, number, unknown, unknown];
    expect(botId).to.equal('testbot');
    expect(userId).to.equal(123);
  });

  it('does NOT include SystemMessage in the messages passed to save', async () => {
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    const [, , savedMessages] = convSvc.save.firstCall.args as [string, number, { role: string; content: string }[], unknown];
    const hasSystem = savedMessages.some(m => m.role === 'system');
    expect(hasSystem).to.be.false;
  });

  it('does NOT include the summary sentinel AIMessage in messages passed to save', async () => {
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    const [, , savedMessages] = convSvc.save.firstCall.args as [string, number, { role: string; content: string }[], unknown];
    const hasSentinel = savedMessages.some(m => m.content.startsWith('Previous conversation summary:'));
    expect(hasSentinel).to.be.false;
  });

  it('DOES include the user HumanMessage in messages passed to save', async () => {
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    const [, , savedMessages] = convSvc.save.firstCall.args as [string, number, { role: string; content: string }[], unknown];
    const hasUser = savedMessages.some(m => m.role === 'user' && m.content === 'user msg');
    expect(hasUser).to.be.true;
  });

  it('DOES include the assistant AIMessage in messages passed to save', async () => {
    const convSvc = makeConvService();
    const state = makeSaveState();

    await saveNode(state, { conversationService: convSvc as any });

    const [, , savedMessages] = convSvc.save.firstCall.args as [string, number, { role: string; content: string }[], unknown];
    const hasAssistant = savedMessages.some(m => m.role === 'assistant' && m.content === 'assistant reply');
    expect(hasAssistant).to.be.true;
  });

  it('passes state.summary as the fourth argument to save', async () => {
    const convSvc = makeConvService();
    const state = makeSaveState(); // summary: 'current summary'

    await saveNode(state, { conversationService: convSvc as any });

    const [, , , summary] = convSvc.save.firstCall.args as [string, number, unknown[], string | null];
    expect(summary).to.equal('current summary');
  });

  it('passes null to save when summary is empty string', async () => {
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
    const convSvc = makeConvService();
    const state = makeSaveState();

    const result = await saveNode(state, { conversationService: convSvc as any });

    expect(result).to.deep.equal({});
  });
});

// ===========================================================================
// T6: agentNode — direct unit tests
// ===========================================================================

describe('agentNode', () => {
  afterEach(() => sinon.restore());

  it('returns object with messages array containing the AI reply', async () => {
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

  it('calls modelFactory.create with the provider and model from state', async () => {
    const { stubFactory } = makeModelFactory('reply');
    const state = makeState({
      messages: [new HumanMessage('test')],
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
    });

    await agentNode(state, { modelFactory: stubFactory });

    expect(stubFactory.create.calledOnceWith('anthropic', 'claude-3-5-sonnet-20241022')).to.be.true;
  });

  it('calls model.invoke with the full state.messages array', async () => {
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
});

// ===========================================================================
// T7: loadHistoryNode — direct unit tests
// ===========================================================================

describe('loadHistoryNode', () => {
  afterEach(() => sinon.restore());

  it('uses system_prompt from DB row as first SystemMessage when no override', async () => {
    const convSvc = makeConvService({ system_prompt: 'sys from db', summary: null });
    const state = makeState({ userInput: 'hi', systemPromptOverride: undefined });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as SystemMessage[];
    expect(msgs[0]).to.be.instanceOf(SystemMessage);
    expect(msgs[0].content).to.equal('sys from db');
  });

  it('uses systemPromptOverride instead of row.system_prompt when override provided', async () => {
    const convSvc = makeConvService({ system_prompt: 'original', summary: null });
    const state = makeState({ userInput: 'hi', systemPromptOverride: 'override prompt' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as SystemMessage[];
    expect(msgs[0]).to.be.instanceOf(SystemMessage);
    expect(msgs[0].content).to.equal('override prompt');
  });

  it('injects summary AIMessage when row.summary is non-empty', async () => {
    const convSvc = makeConvService({ system_prompt: null, summary: 'some summary' });
    const state = makeState({ userInput: 'hi', systemPromptOverride: undefined });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as (HumanMessage | AIMessage)[];
    const summaryMsg = msgs.find(m => m instanceof AIMessage && String(m.content).includes('some summary'));
    expect(summaryMsg).to.exist;
  });

  it('does NOT inject summary AIMessage when row.summary is null', async () => {
    const convSvc = makeConvService({ system_prompt: null, summary: null });
    const state = makeState({ userInput: 'hi' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as (HumanMessage | AIMessage)[];
    const summaryMsg = msgs.find(m => m instanceof AIMessage && String(m.content).startsWith('Previous conversation summary:'));
    expect(summaryMsg).to.not.exist;
  });

  it('does NOT inject summary AIMessage when row.summary is empty string', async () => {
    const convSvc = makeConvService({ system_prompt: null, summary: '' });
    const state = makeState({ userInput: 'hi' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as (HumanMessage | AIMessage)[];
    const summaryMsg = msgs.find(m => m instanceof AIMessage && String(m.content).startsWith('Previous conversation summary:'));
    expect(summaryMsg).to.not.exist;
  });

  it('appends state.userInput as the LAST HumanMessage in returned messages', async () => {
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
    const convSvc = makeConvService({ system_prompt: null, summary: null, messages: [] });
    const state = makeState({ userInput: 'only message' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as HumanMessage[];
    expect(msgs).to.have.length(1);
    expect(msgs[0]).to.be.instanceOf(HumanMessage);
    expect(msgs[0].content).to.equal('only message');
  });

  it('places [SystemMessage, HumanMessage(userInput)] when system_prompt set and no history', async () => {
    const convSvc = makeConvService({ system_prompt: 'be helpful', summary: null, messages: [] });
    const state = makeState({ userInput: 'hello' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    const msgs = result.messages as (SystemMessage | HumanMessage)[];
    expect(msgs).to.have.length(2);
    expect(msgs[0]).to.be.instanceOf(SystemMessage);
    expect(msgs[1]).to.be.instanceOf(HumanMessage);
    expect(msgs[1].content).to.equal('hello');
  });

  it('returns provider and model fields from the DB row', async () => {
    const convSvc = makeConvService({
      llm_provider: 'anthropic',
      llm_model: 'claude-3-5-sonnet-20241022',
      summarization_provider: 'openai',
      summarization_model: 'gpt-4o-mini',
      system_prompt: null,
      summary: null,
    });
    const state = makeState({ userInput: 'hi' });

    const result = await loadHistoryNode(state, { conversationService: convSvc as any });

    expect(result.provider).to.equal('anthropic');
    expect(result.model).to.equal('claude-3-5-sonnet-20241022');
    expect(result.summarizationProvider).to.equal('openai');
    expect(result.summarizationModel).to.equal('gpt-4o-mini');
  });
});
