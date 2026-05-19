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

  it('clears _pendingMessages after _generate completes', async () => {
    const { ChatDeepSeekWithReasoning } = mod;
    const instance = new ChatDeepSeekWithReasoning({ apiKey: 'sk-test', model: 'deepseek-reasoner' }) as unknown as {
      _pendingMessages: BaseMessage[];
      _generate(m: BaseMessage[], o: unknown): Promise<unknown>;
    };

    await instance._generate([makeHumanMessage('hi')], {} as never);

    expect(instance._pendingMessages).to.have.length(0);
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
    });
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge(mod);
  });

  type Param = import('openai').default.Chat.Completions.ChatCompletionMessageParam;

  function assistantWithToolCalls(ids: string[]): Param {
    return {
      role: 'assistant',
      content: null,
      tool_calls: ids.map((id) => ({
        id,
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

  it('keeps an orphan tool message that has no preceding assistant+tool_calls', () => {
    const { sanitizeToolCallSequences } = mod;
    const input: Param[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan result', tool_call_id: 'orphan-id' } as Param,
      { role: 'user', content: 'follow' },
    ];
    const result = sanitizeToolCallSequences(input);
    expect(result).to.have.length(3);
    expect(result[1].role).to.equal('tool');
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
