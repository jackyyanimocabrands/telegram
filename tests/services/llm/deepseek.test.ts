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
