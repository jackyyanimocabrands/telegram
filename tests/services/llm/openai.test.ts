import { describe, it } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { OpenAiProvider } from '../../../src/services/llm/openai.js';

function makeFetchStub(status: number, body: unknown): sinon.SinonStub {
  return sinon.stub().resolves({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

describe('OpenAiProvider', () => {
  const model = 'gpt-4o';

  describe('complete', () => {
    it('returns the message content on a successful response', async () => {
      const fetchStub = makeFetchStub(200, {
        choices: [{ message: { content: 'Hello from OpenAI!' } }],
      });
      const provider = new OpenAiProvider('sk-test', model, fetchStub);

      const result = await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(result).to.equal('Hello from OpenAI!');
    });

    it('calls the correct OpenAI endpoint', async () => {
      const fetchStub = makeFetchStub(200, {
        choices: [{ message: { content: 'ok' } }],
      });
      const provider = new OpenAiProvider('sk-test', model, fetchStub);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      expect(fetchStub.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[0]).to.equal('https://api.openai.com/v1/chat/completions');
    });

    it('sends Authorization header with Bearer token', async () => {
      const fetchStub = makeFetchStub(200, {
        choices: [{ message: { content: 'ok' } }],
      });
      const provider = new OpenAiProvider('sk-my-api-key', model, fetchStub);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      const { headers } = fetchStub.firstCall.args[1] as RequestInit;
      expect((headers as Record<string, string>)['Authorization']).to.equal('Bearer sk-my-api-key');
    });

    it('passes options maxTokens and temperature to the request body', async () => {
      const fetchStub = makeFetchStub(200, {
        choices: [{ message: { content: 'ok' } }],
      });
      const provider = new OpenAiProvider('sk-test', model, fetchStub);

      await provider.complete([{ role: 'user', content: 'Hi' }], { maxTokens: 512, temperature: 0.3 });

      const body = JSON.parse((fetchStub.firstCall.args[1] as RequestInit).body as string);
      expect(body.max_tokens).to.equal(512);
      expect(body.temperature).to.equal(0.3);
    });

    it('uses defaults (maxTokens=1024, temperature=0.7) when no options provided', async () => {
      const fetchStub = makeFetchStub(200, {
        choices: [{ message: { content: 'ok' } }],
      });
      const provider = new OpenAiProvider('sk-test', model, fetchStub);

      await provider.complete([{ role: 'user', content: 'Hi' }]);

      const body = JSON.parse((fetchStub.firstCall.args[1] as RequestInit).body as string);
      expect(body.max_tokens).to.equal(1024);
      expect(body.temperature).to.equal(0.7);
    });

    it('throws on a non-2xx response', async () => {
      const fetchStub = makeFetchStub(401, {
        error: { message: 'Invalid API key' },
      });
      const provider = new OpenAiProvider('sk-bad', model, fetchStub);

      let err: Error | undefined;
      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err!.message).to.match(/OpenAI API error: 401 Invalid API key/);
    });

    it('throws with "unknown" when error message is absent on non-2xx', async () => {
      const fetchStub = makeFetchStub(500, {});
      const provider = new OpenAiProvider('sk-test', model, fetchStub);

      let err: Error | undefined;
      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err!.message).to.match(/OpenAI API error: 500 unknown/);
    });

    it('throws when choices array is empty on 2xx response', async () => {
      const fetchStub = makeFetchStub(200, { choices: [] });
      const provider = new OpenAiProvider('sk-test', model, fetchStub);

      let err: Error | undefined;
      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err!.message).to.include('OpenAI API error');
    });

    it('throws when choices field is missing on 2xx response', async () => {
      const fetchStub = makeFetchStub(200, {});
      const provider = new OpenAiProvider('sk-test', model, fetchStub);

      let err: Error | undefined;
      try {
        await provider.complete([{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        err = e as Error;
      }
      expect(err).to.be.instanceOf(Error);
      expect(err!.message).to.include('OpenAI API error');
    });
  });
});
