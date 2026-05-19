import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAIMessage(content: string, reasoningContent?: string): AIMessage {
  return new AIMessage({
    content,
    additional_kwargs: reasoningContent ? { reasoning_content: reasoningContent } : {},
  });
}

function makeHumanMessage(content: string): BaseMessage {
  return new HumanMessage(content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatDeepSeekWithReasoning', () => {
  let mod: typeof import('../../../src/services/llm/deepseek.js');
  let superCompletionWithRetryStub: sinon.SinonStub;

  // We use the real @langchain/core/messages (so AIMessage.isInstance works)
  // but mock @langchain/deepseek to avoid network/env dependencies.

  beforeEach(async () => {
    superCompletionWithRetryStub = sinon.stub().resolves({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    // FakeChatDeepSeek mirrors the part of ChatOpenAICompletions that
    // convertMessagesToCompletionsMessageParams + calls completionWithRetry.
    //
    // IMPORTANT: completionWithRetry must be declared as a prototype method
    // (not a class field / instance property). Class fields are assigned in the
    // constructor, so a parent class field `completionWithRetry = stub` would
    // overwrite the subclass's prototype override when `super()` runs.
    class FakeChatDeepSeek {
      model = 'deepseek-reasoner';

      constructor(_fields: unknown) {}

      invocationParams(_options?: unknown): Record<string, unknown> {
        return { stream: false };
      }

      async _generate(messages: BaseMessage[], _options: unknown, _runManager?: unknown) {
        const messagesMapped = messages.map((m) => ({
          role: m._getType() === 'ai' ? 'assistant' : 'user',
          content: typeof m.content === 'string' ? m.content : '',
        }));
        await this.completionWithRetry({ stream: false, model: this.model, messages: messagesMapped });
        return { generations: [{ text: 'ok', message: { content: 'ok' } }] };
      }

      // Returns AsyncGenerator via an immediately-invoked async generator expression
      // to avoid esbuild complaints about await inside async generator method bodies.
      _streamResponseChunks(messages: BaseMessage[], _options: unknown, _runManager?: unknown): AsyncGenerator<never> {
        const self = this;
        const messagesMapped = messages.map((m) => ({
          role: m._getType() === 'ai' ? 'assistant' : 'user',
          content: typeof m.content === 'string' ? m.content : '',
        }));
        return (async function* () {
          await self.completionWithRetry({ stream: true, model: self.model, messages: messagesMapped });
        })();
      }

      completionWithRetry(...args: unknown[]): unknown {
        return superCompletionWithRetryStub(...args);
      }
    }

    mod = await esmock('../../../src/services/llm/deepseek.js', {
      '@langchain/deepseek': { ChatDeepSeek: FakeChatDeepSeek },
      '../../../src/utils/logger.js': { logger: { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() } },
    });
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge(mod);
  });

  // -------------------------------------------------------------------------

  it('injects reasoning_content into assistant message params during _generate', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    const messages: BaseMessage[] = [
      makeHumanMessage('What is 1+1?'),
      makeAIMessage('Let me think...', 'I will reason step by step.'),
      makeHumanMessage('Are you sure?'),
    ];

    await instance._generate(messages, {} as never);

    expect(superCompletionWithRetryStub.calledOnce).to.be.true;
    const request = superCompletionWithRetryStub.firstCall.args[0];
    const assistantParam = request.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistantParam).to.exist;
    expect((assistantParam as { reasoning_content?: string }).reasoning_content).to.equal('I will reason step by step.');
  });

  it('does not inject reasoning_content when AIMessage has none', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    const messages: BaseMessage[] = [
      makeHumanMessage('Hello'),
      makeAIMessage('Hi there'),
    ];

    await instance._generate(messages, {} as never);

    expect(superCompletionWithRetryStub.calledOnce).to.be.true;
    const request = superCompletionWithRetryStub.firstCall.args[0];
    const assistantParam = request.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistantParam).to.exist;
    expect((assistantParam as Record<string, unknown>).reasoning_content).to.be.undefined;
  });

  it('does not inject when reasoning_content is an empty string', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    const messages: BaseMessage[] = [
      makeHumanMessage('Hello'),
      makeAIMessage('Hi', ''),
    ];

    await instance._generate(messages, {} as never);

    const request = superCompletionWithRetryStub.firstCall.args[0];
    const assistantParam = request.messages.find((m: { role: string }) => m.role === 'assistant');
    expect((assistantParam as Record<string, unknown>).reasoning_content).to.be.undefined;
  });

  it('injects correct reasoning_content for multiple assistant messages', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    const messages: BaseMessage[] = [
      makeHumanMessage('Turn 1'),
      makeAIMessage('Reply 1', 'Reasoning A'),
      makeHumanMessage('Turn 2'),
      makeAIMessage('Reply 2', 'Reasoning B'),
      makeHumanMessage('Turn 3'),
    ];

    await instance._generate(messages, {} as never);

    const request = superCompletionWithRetryStub.firstCall.args[0];
    const assistantParams = request.messages.filter((m: { role: string }) => m.role === 'assistant');
    expect(assistantParams).to.have.length(2);
    expect((assistantParams[0] as { reasoning_content?: string }).reasoning_content).to.equal('Reasoning A');
    expect((assistantParams[1] as { reasoning_content?: string }).reasoning_content).to.equal('Reasoning B');
  });

  it('does not inject reasoning_content for non-assistant (human) messages', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    const messages: BaseMessage[] = [
      makeHumanMessage('Hello'),
    ];

    await instance._generate(messages, {} as never);

    const request = superCompletionWithRetryStub.firstCall.args[0];
    const userParam = request.messages.find((m: { role: string }) => m.role === 'user');
    expect(userParam).to.exist;
    expect((userParam as Record<string, unknown>).reasoning_content).to.be.undefined;
  });

  it('injects reasoning_content during _streamResponseChunks', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    const messages: BaseMessage[] = [
      makeHumanMessage('Think hard'),
      makeAIMessage('I computed this', 'Stream reasoning here'),
      makeHumanMessage('Continue'),
    ];

    // Drain the generator (stub-based parent produces no yielded values)
    const gen = instance._streamResponseChunks(messages, {} as never);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of gen) { /* drain */ }

    expect(superCompletionWithRetryStub.calledOnce).to.be.true;
    const request = superCompletionWithRetryStub.firstCall.args[0];
    const assistantParam = request.messages.find((m: { role: string }) => m.role === 'assistant');
    expect((assistantParam as { reasoning_content?: string }).reasoning_content).to.equal('Stream reasoning here');
  });

  it('concurrent _streamResponseChunks calls on the same instance inject correct reasoning_content for each call independently', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    const messagesA: BaseMessage[] = [
      makeHumanMessage('Stream question A'),
      makeAIMessage('Stream answer A', 'Stream reasoning for A'),
      makeHumanMessage('Stream follow up A'),
    ];

    const messagesB: BaseMessage[] = [
      makeHumanMessage('Stream question B'),
      makeAIMessage('Stream answer B', 'Stream reasoning for B'),
      makeHumanMessage('Stream follow up B'),
    ];

    // Drain both generators concurrently on the same cached instance
    async function drainGenerator(gen: AsyncGenerator<unknown>): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of gen) { /* drain */ }
    }

    await Promise.all([
      drainGenerator(instance._streamResponseChunks(messagesA, {} as never)),
      drainGenerator(instance._streamResponseChunks(messagesB, {} as never)),
    ]);

    expect(superCompletionWithRetryStub.callCount).to.equal(2);

    // Collect reasoning_content values from each completionWithRetry call
    const reasoningValues = superCompletionWithRetryStub.args.map((args) => {
      const req = args[0] as { messages: Array<{ role: string; reasoning_content?: string }> };
      const assistantParam = req.messages.find((m) => m.role === 'assistant');
      return assistantParam?.reasoning_content;
    });

    // Both calls must have injected their own reasoning_content — no cross-contamination
    expect(reasoningValues).to.include('Stream reasoning for A');
    expect(reasoningValues).to.include('Stream reasoning for B');
    // Each value must appear exactly once
    expect(reasoningValues.filter((v) => v === 'Stream reasoning for A')).to.have.length(1);
    expect(reasoningValues.filter((v) => v === 'Stream reasoning for B')).to.have.length(1);
  });

  it('no longer exposes _pendingMessages — state is scoped via AsyncLocalStorage', async () => {
    // This test documents the post-refactor invariant: the instance has no
    // _pendingMessages field (removed in favour of AsyncLocalStorage).
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' }) as unknown as Record<string, unknown>;

    await instance['_generate']([makeHumanMessage('hi')], {} as never);

    expect(instance['_pendingMessages']).to.be.undefined;
  });

  // -------------------------------------------------------------------------
  // QA Blocker 2 — Concurrency: concurrent _generate calls on same instance
  // -------------------------------------------------------------------------

  it('concurrent _generate calls on the same instance inject correct reasoning_content for each call independently', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    const messagesA: BaseMessage[] = [
      makeHumanMessage('Question A'),
      makeAIMessage('Answer A', 'Reasoning for A'),
      makeHumanMessage('Follow up A'),
    ];

    const messagesB: BaseMessage[] = [
      makeHumanMessage('Question B'),
      makeAIMessage('Answer B', 'Reasoning for B'),
      makeHumanMessage('Follow up B'),
    ];

    // Fire both concurrently on the same cached instance
    await Promise.all([
      instance._generate(messagesA, {} as never),
      instance._generate(messagesB, {} as never),
    ]);

    expect(superCompletionWithRetryStub.callCount).to.equal(2);

    // Collect the reasoning_content values from each completionWithRetry call
    const reasoningValues = superCompletionWithRetryStub.args.map((args) => {
      const req = args[0] as { messages: Array<{ role: string; reasoning_content?: string }> };
      const assistantParam = req.messages.find((m) => m.role === 'assistant');
      return assistantParam?.reasoning_content;
    });

    // Both calls must have injected their own reasoning_content — no cross-contamination
    expect(reasoningValues).to.include('Reasoning for A');
    expect(reasoningValues).to.include('Reasoning for B');
    // Each value must appear exactly once
    expect(reasoningValues.filter((v) => v === 'Reasoning for A')).to.have.length(1);
    expect(reasoningValues.filter((v) => v === 'Reasoning for B')).to.have.length(1);
  });

  // -------------------------------------------------------------------------
  // QA Blocker 3 — Error path: failed call does not leak state to next call
  // -------------------------------------------------------------------------

  it('subsequent _generate call after a failed call uses its own messages, not stale state', async () => {
    // First call throws; second call must still see its own messages.
    let callCount = 0;
    superCompletionWithRetryStub.callsFake((..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('simulated API error'));
      }
      return Promise.resolve({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    });

    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    const firstMessages: BaseMessage[] = [
      makeHumanMessage('First call'),
      makeAIMessage('First AI reply', 'Reasoning from first call'),
      makeHumanMessage('Continue first'),
    ];

    const secondMessages: BaseMessage[] = [
      makeHumanMessage('Second call'),
      makeAIMessage('Second AI reply', 'Reasoning from second call'),
      makeHumanMessage('Continue second'),
    ];

    // First call must reject
    let firstCallError: unknown;
    try {
      await instance._generate(firstMessages, {} as never);
    } catch (err) {
      firstCallError = err;
    }
    expect(firstCallError).to.be.instanceOf(Error);
    expect((firstCallError as Error).message).to.equal('simulated API error');

    // Second call must succeed and use its own messages
    await instance._generate(secondMessages, {} as never);

    expect(superCompletionWithRetryStub.callCount).to.equal(2);
    const secondCallRequest = superCompletionWithRetryStub.secondCall.args[0] as {
      messages: Array<{ role: string; reasoning_content?: string }>;
    };
    const assistantParam = secondCallRequest.messages.find((m) => m.role === 'assistant');
    expect(assistantParam).to.exist;
    // Must have injected the second call's reasoning only
    expect(assistantParam?.reasoning_content).to.equal('Reasoning from second call');
  });
});

// ---------------------------------------------------------------------------
// sanitizeToolCallSequences — unit tests
// ---------------------------------------------------------------------------

describe('sanitizeToolCallSequences', () => {
  let mod: typeof import('../../../src/services/llm/deepseek.js');

  beforeEach(async () => {
    // We only need the named export — use a minimal stub for ChatDeepSeek
    class FakeChatDeepSeek {
      constructor(_fields: unknown) {}
    }
    mod = await esmock('../../../src/services/llm/deepseek.js', {
      '@langchain/deepseek': { ChatDeepSeek: FakeChatDeepSeek },
      '../../../src/utils/logger.js': { logger: { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() } },
    });
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge(mod);
  });

  type Param = import('openai').default.Chat.Completions.ChatCompletionMessageParam;

  function assistantWithToolCalls(ids: (string | undefined)[]): Param {
    return {
      role: 'assistant',
      content: null,
      tool_calls: ids.map((id) => ({
        id: id as string,
        type: 'function' as const,
        function: { name: 'fn', arguments: '{}' },
      })),
    };
  }

  function toolMessage(toolCallId: string): Param {
    return { role: 'tool', content: 'result', tool_call_id: toolCallId };
  }

  it('keeps a complete group (assistant + all tool responses) intact', () => {
    const { sanitizeToolCallSequences } = mod;
    const input: Param[] = [
      { role: 'user', content: 'hello' },
      assistantWithToolCalls(['id-1']),
      toolMessage('id-1'),
      { role: 'user', content: 'follow-up' },
    ];
    const result = sanitizeToolCallSequences(input);
    expect(result).to.have.length(4);
    expect(result[1].role).to.equal('assistant');
    expect(result[2].role).to.equal('tool');
  });

  it('drops an incomplete group where no tool messages follow the assistant', () => {
    const { sanitizeToolCallSequences } = mod;
    const input: Param[] = [
      { role: 'user', content: 'hello' },
      assistantWithToolCalls(['id-1']),
      { role: 'user', content: 'next message' },
    ];
    const result = sanitizeToolCallSequences(input);
    expect(result).to.have.length(2);
    expect(result[0].role).to.equal('user');
    expect(result[1].role).to.equal('user');
  });

  it('drops a partial group where only some tool responses are present', () => {
    const { sanitizeToolCallSequences } = mod;
    const input: Param[] = [
      assistantWithToolCalls(['id-1', 'id-2']),
      toolMessage('id-1'),
      // id-2 is missing
      { role: 'user', content: 'next' },
    ];
    const result = sanitizeToolCallSequences(input);
    expect(result).to.have.length(1);
    expect(result[0].role).to.equal('user');
  });

  it('drops an orphan tool message that has no preceding assistant+tool_calls', () => {
    const { sanitizeToolCallSequences } = mod;
    const input: Param[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan result', tool_call_id: 'orphan-id' } as Param,
      { role: 'user', content: 'follow' },
    ];
    const result = sanitizeToolCallSequences(input);
    expect(result).to.have.length(2);
    expect(result[0].role).to.equal('user');
    expect(result[1].role).to.equal('user');
  });

  it('drops multiple consecutive orphan tool messages', () => {
    const { sanitizeToolCallSequences } = mod;
    const input: Param[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan 1', tool_call_id: 'orphan-id-1' } as Param,
      { role: 'tool', content: 'orphan 2', tool_call_id: 'orphan-id-2' } as Param,
      { role: 'user', content: 'follow' },
    ];
    const result = sanitizeToolCallSequences(input);
    expect(result).to.have.length(2);
    expect(result[0].role).to.equal('user');
    expect(result[1].role).to.equal('user');
  });

  it('keeps two consecutive complete groups', () => {
    const { sanitizeToolCallSequences } = mod;
    const input: Param[] = [
      assistantWithToolCalls(['a1']),
      toolMessage('a1'),
      assistantWithToolCalls(['b1']),
      toolMessage('b1'),
    ];
    const result = sanitizeToolCallSequences(input);
    expect(result).to.have.length(4);
    expect(result[0].role).to.equal('assistant');
    expect(result[1].role).to.equal('tool');
    expect(result[2].role).to.equal('assistant');
    expect(result[3].role).to.equal('tool');
  });

  // -------------------------------------------------------------------------
  // QA Blocker 5 — Undefined tool_call id edge case
  // -------------------------------------------------------------------------

  it('mixed valid/undefined tool_call ids: group is KEPT when all string ids are answered', () => {
    // tool_calls with undefined id are excluded from expectedIds — only
    // string ids must be answered. So a group where the only string id IS
    // answered is treated as complete and kept.
    const { sanitizeToolCallSequences } = mod;
    const input: Param[] = [
      // One real id + one undefined id
      assistantWithToolCalls(['real-id', undefined]),
      toolMessage('real-id'),
      { role: 'user', content: 'follow' },
    ];
    const result = sanitizeToolCallSequences(input);
    // expectedIds = Set { 'real-id' } (undefined filtered out)
    // answeredIds = Set { 'real-id' }
    // isComplete  = true → group is KEPT
    expect(result).to.have.length(3);
    expect(result[0].role).to.equal('assistant');
    expect(result[1].role).to.equal('tool');
    expect(result[2].role).to.equal('user');
  });
});

// ---------------------------------------------------------------------------
// injectReasoningContent — unit tests (named export)
// ---------------------------------------------------------------------------

describe('injectReasoningContent', () => {
  let mod: typeof import('../../../src/services/llm/deepseek.js');
  let warnStub: sinon.SinonStub;

  beforeEach(async () => {
    warnStub = sinon.stub();
    class FakeChatDeepSeek {
      constructor(_fields: unknown) {}
    }
    mod = await esmock('../../../src/services/llm/deepseek.js', {
      '@langchain/deepseek': { ChatDeepSeek: FakeChatDeepSeek },
      '../../../src/utils/logger.js': { logger: { warn: warnStub, info: sinon.stub(), error: sinon.stub() } },
    });
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge(mod);
  });

  type Param = import('openai').default.Chat.Completions.ChatCompletionMessageParam;

  // -------------------------------------------------------------------------
  // QA Blocker 4 — Positional mapping mismatch (fewer AIMessages than params)
  // -------------------------------------------------------------------------

  it('gracefully handles fewer AIMessages than assistant params (no crash, no wrong injection)', () => {
    const { injectReasoningContent } = mod;

    // One human message (zero AIMessages)
    const originalMessages: BaseMessage[] = [makeHumanMessage('Hello')];

    // One assistant param but no source AIMessage to match against
    const mappedParams: Param[] = [
      { role: 'assistant', content: 'x' },
    ];

    let result: Param[];
    expect(() => {
      result = injectReasoningContent(originalMessages, mappedParams);
    }).to.not.throw();

    // No AIMessage to pull reasoning_content from → no injection
    const assistantParam = result![0] as Record<string, unknown>;
    expect(assistantParam.reasoning_content).to.be.undefined;
  });

  it('strips null bytes from reasoning_content before injection', () => {
    const { injectReasoningContent } = mod;

    const originalMessages: BaseMessage[] = [
      makeHumanMessage('hi'),
      makeAIMessage('reply', 'good\0content\0here'),
      makeHumanMessage('follow up'),
    ];

    const mappedParams: Param[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow up' },
    ];

    const result = injectReasoningContent(originalMessages, mappedParams);
    const assistantParam = result.find((p) => p.role === 'assistant') as Record<string, unknown>;
    expect(assistantParam.reasoning_content).to.equal('goodcontenthere');
  });

  it('truncates reasoning_content exceeding MAX_REASONING_CONTENT_LENGTH and emits a warning', () => {
    const { injectReasoningContent } = mod;

    const oversized = 'x'.repeat(32_769); // 1 byte over the 32 KB limit

    const originalMessages: BaseMessage[] = [
      makeHumanMessage('hi'),
      makeAIMessage('reply', oversized),
      makeHumanMessage('follow up'),
    ];

    const mappedParams: Param[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow up' },
    ];

    const result = injectReasoningContent(originalMessages, mappedParams);
    const assistantParam = result.find((p) => p.role === 'assistant') as Record<string, unknown>;

    expect((assistantParam.reasoning_content as string).length).to.equal(32_768);
    expect(warnStub.calledOnce).to.be.true;
    expect(warnStub.firstCall.args[0]).to.deep.include({ originalLength: 32_769 });
  });
});

// ---------------------------------------------------------------------------
// Integration: completionWithRetry sanitises incomplete tool-call sequences
// ---------------------------------------------------------------------------

describe('ChatDeepSeekWithReasoning — completionWithRetry sanitises tool-call sequences', () => {
  let mod: typeof import('../../../src/services/llm/deepseek.js');
  let superCompletionWithRetryStub: sinon.SinonStub;

  beforeEach(async () => {
    superCompletionWithRetryStub = sinon.stub().resolves({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    class FakeChatDeepSeek {
      model = 'deepseek-reasoner';
      constructor(_fields: unknown) {}
      invocationParams(_options?: unknown): Record<string, unknown> {
        return { stream: false };
      }
      async _generate(messages: BaseMessage[], _options: unknown, _runManager?: unknown) {
        const messagesMapped = messages.map((m) => ({
          role: m._getType() === 'ai' ? 'assistant' : 'user',
          content: typeof m.content === 'string' ? m.content : '',
        }));
        await this.completionWithRetry({ stream: false, model: this.model, messages: messagesMapped });
        return { generations: [{ text: 'ok', message: { content: 'ok' } }] };
      }
      completionWithRetry(...args: unknown[]): unknown {
        return superCompletionWithRetryStub(...args);
      }
    }

    mod = await esmock('../../../src/services/llm/deepseek.js', {
      '@langchain/deepseek': { ChatDeepSeek: FakeChatDeepSeek },
      '../../../src/utils/logger.js': { logger: { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() } },
    });
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge(mod);
  });

  it('strips incomplete assistant+tool_calls from history before calling super', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' });

    // Directly call completionWithRetry with a pre-built messages array that
    // contains an assistant message with tool_calls but no following tool message.
    const incompleteMessages = [
      { role: 'user' as const, content: 'Call the tool' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'my_tool', arguments: '{}' } }],
      },
      // No tool message — simulates reloaded history with missing ToolMessages
      { role: 'user' as const, content: 'what happened?' },
    ];

    await instance.completionWithRetry({
      stream: false,
      model: 'deepseek-reasoner',
      messages: incompleteMessages,
    });

    expect(superCompletionWithRetryStub.calledOnce).to.be.true;
    const passedMessages: Array<{ role: string }> = superCompletionWithRetryStub.firstCall.args[0].messages;

    // The incomplete assistant message must have been stripped
    const assistantMsg = passedMessages.find((m) => m.role === 'assistant');
    expect(assistantMsg).to.be.undefined;

    // The user messages should still be present
    const userMsgs = passedMessages.filter((m) => m.role === 'user');
    expect(userMsgs).to.have.length(2);
  });
});
