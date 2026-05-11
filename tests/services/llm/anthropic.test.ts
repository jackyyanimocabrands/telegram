import { describe, it } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AnthropicProvider } from '../../../src/services/llm/anthropic.js';

function makeFetchStub(status: number, body: unknown): sinon.SinonStub {
  return sinon.stub().resolves({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

describe('AnthropicProvider', () => {
  const model = 'claude-3-5-sonnet-20241022';

  describe('complete', () => {
    it('returns the text content on a successful response', async () => {
      const fetchStub = makeFetchStub(200, {
        content: [{ text: 'Hello from Anthropic!' }],
      });
      const provider = new AnthropicProvider('sk-ant-test', model, fetchStub);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(result).to.equal('Hello from Anthropic!');
    });

    it('calls the correct Anthropic endpoint', async () => {
      const fetchStub = makeFetchStub(200, { content: [{ text: 'ok' }] });
      const provider = new AnthropicProvider('sk-ant-test', model, fetchStub);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(fetchStub.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[0]).to.equal('https://api.anthropic.com/v1/messages');
    });

    it('sends x-api-key and anthropic-version headers', async () => {
      const fetchStub = makeFetchStub(200, { content: [{ text: 'ok' }] });
      const provider = new AnthropicProvider('sk-ant-my-key', model, fetchStub);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      const { headers } = fetchStub.firstCall.args[1] as RequestInit;
      const h = headers as Record<string, string>;
      expect(h['x-api-key']).to.equal('sk-ant-my-key');
      expect(h['anthropic-version']).to.equal('2023-06-01');
    });

    it('extracts system message to top-level system field', async () => {
      const fetchStub = makeFetchStub(200, { content: [{ text: 'ok' }] });
      const provider = new AnthropicProvider('sk-ant-test', model, fetchStub);

      await provider.complete([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ]);

      const body = JSON.parse((fetchStub.firstCall.args[1] as RequestInit).body as string);
      expect(body.system).to.equal('You are a helpful assistant.');
      expect(body.messages).to.deep.equal([{ role: 'user', content: 'Hello' }]);
    });

    it('does not include system field when no system message is present', async () => {
      const fetchStub = makeFetchStub(200, { content: [{ text: 'ok' }] });
      const provider = new AnthropicProvider('sk-ant-test', model, fetchStub);

      await provider.complete([{ role: 'user', content: 'Hello' }]);

      const body = JSON.parse((fetchStub.firstCall.args[1] as RequestInit).body as string);
      expect(body).to.not.have.property('system');
    });

    it('passes max_tokens from options', async () => {
      const fetchStub = makeFetchStub(200, { content: [{ text: 'ok' }] });
      const provider = new AnthropicProvider('sk-ant-test', model, fetchStub);

      await provider.complete([{ role: 'user', content: 'Hi' }], { maxTokens: 256 });

      const body = JSON.parse((fetchStub.firstCall.args[1] as RequestInit).body as string);
      expect(body.max_tokens).to.equal(256);
    });

    it('uses default max_tokens=1024 when no options provided', async () => {
      const fetchStub = makeFetchStub(200, { content: [{ text: 'ok' }] });
      const provider = new AnthropicProvider('sk-ant-test', model, fetchStub);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      const body = JSON.parse((fetchStub.firstCall.args[1] as RequestInit).body as string);
      expect(body.max_tokens).to.equal(1024);
    });

    it('throws on a non-2xx response with error message', async () => {
      const fetchStub = makeFetchStub(401, {
        error: { message: 'Invalid API key' },
      });
      const provider = new AnthropicProvider('sk-ant-bad', model, fetchStub);

      let err: Error | undefined;
      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err!.message).to.match(/Anthropic API error: 401 Invalid API key/);
    });

    it('throws with "unknown" when error message is absent on non-2xx', async () => {
      const fetchStub = makeFetchStub(500, {});
      const provider = new AnthropicProvider('sk-ant-test', model, fetchStub);

      let err: Error | undefined;
      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err!.message).to.match(/Anthropic API error: 500 unknown/);
    });

    it('throws when content array is empty on 2xx response', async () => {
      const fetchStub = makeFetchStub(200, { content: [] });
      const provider = new AnthropicProvider('sk-ant-test', model, fetchStub);

      let err: Error | undefined;
      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err!.message).to.include('Anthropic API error');
    });

    it('throws when content field is missing on 2xx response', async () => {
      const fetchStub = makeFetchStub(200, {});
      const provider = new AnthropicProvider('sk-ant-test', model, fetchStub);

      let err: Error | undefined;
      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err!.message).to.include('Anthropic API error');
    });
  });
});
