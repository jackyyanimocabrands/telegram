import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { LlmProviderFactory } from '../../../src/services/llm/factory.js';

// Minimal stub constructor that satisfies BaseChatModel's `invoke` interface
function makeStubCtor(name: string) {
  return class {
    _name = name;
    invoke = sinon.stub().resolves({ content: 'stub' });
  } as any;
}

const stubCtors = {
  ChatOpenAI:    makeStubCtor('ChatOpenAI'),
  ChatAnthropic: makeStubCtor('ChatAnthropic'),
  ChatDeepSeek:  makeStubCtor('ChatDeepSeek'),
  ChatOpenRouter: makeStubCtor('ChatOpenRouter'),
};

const fakeKeys = {
  openai:     'sk-openai-test',
  anthropic:  'sk-ant-test',
  deepseek:   'sk-deepseek-test',
  openrouter: 'sk-or-test',
};

describe('LlmProviderFactory', () => {
  describe('create', () => {
    it('returns a ChatOpenAI instance for provider "openai"', () => {
      const factory = new LlmProviderFactory(stubCtors, fakeKeys);
      const instance = factory.create('openai', 'gpt-4o');
      expect(instance).to.be.instanceOf(stubCtors.ChatOpenAI);
    });

    it('returns a ChatAnthropic instance for provider "anthropic"', () => {
      const factory = new LlmProviderFactory(stubCtors, fakeKeys);
      const instance = factory.create('anthropic', 'claude-3-5-sonnet-20241022');
      expect(instance).to.be.instanceOf(stubCtors.ChatAnthropic);
    });

    it('returns a ChatDeepSeek instance for provider "deepseek"', () => {
      const factory = new LlmProviderFactory(stubCtors, fakeKeys);
      const instance = factory.create('deepseek', 'deepseek-chat');
      expect(instance).to.be.instanceOf(stubCtors.ChatDeepSeek);
    });

    it('returns a ChatOpenRouter instance for provider "openrouter"', () => {
      const factory = new LlmProviderFactory(stubCtors, fakeKeys);
      const instance = factory.create('openrouter', 'openai/gpt-4o');
      expect(instance).to.be.instanceOf(stubCtors.ChatOpenRouter);
    });

    it('throws a descriptive error for an unknown provider', () => {
      const factory = new LlmProviderFactory(stubCtors, fakeKeys);
      expect(() => factory.create('gemini', 'gemini-pro')).to.throw(/Unknown LLM provider.*gemini/);
    });

    it('throws when API key is missing for the requested provider', () => {
      const factory = new LlmProviderFactory(stubCtors, { deepseek: '' }); // explicit empty — no fallback
      expect(() => factory.create('deepseek', 'deepseek-chat')).to.throw(/DeepSeek API key is not configured/);
    });

    it('implements the BaseChatModel interface (has invoke method)', () => {
      const factory = new LlmProviderFactory(stubCtors, fakeKeys);
      const instance = factory.create('openai', 'gpt-4o');
      expect(instance).to.have.property('invoke').that.is.a('function');
    });

    it('returns the same cached instance on repeated calls', () => {
      const factory = new LlmProviderFactory(stubCtors, fakeKeys);
      const first  = factory.create('deepseek', 'deepseek-chat');
      const second = factory.create('deepseek', 'deepseek-chat');
      expect(first).to.equal(second);
    });

    it('returns different instances for different provider+model combinations', () => {
      const factory = new LlmProviderFactory(stubCtors, fakeKeys);
      const a = factory.create('openai',   'gpt-4o');
      const b = factory.create('deepseek', 'deepseek-chat');
      expect(a).to.not.equal(b);
    });
  });

  // -------------------------------------------------------------------------
  // Default constructor wiring: factory uses ChatDeepSeekWithReasoning
  // -------------------------------------------------------------------------
  describe('default deepseek constructor is ChatDeepSeekWithReasoning', () => {
    let factoryMod: typeof import('../../../src/services/llm/factory.js');
    let deepseekMod: typeof import('../../../src/services/llm/deepseek.js');

    afterEach(async () => {
      await esmock.purge(factoryMod);
    });

    it('creates a ChatDeepSeekWithReasoning instance when no constructor override is supplied', async () => {
      // Stub only @langchain/deepseek so no real network/env is needed.
      // The real ChatDeepSeekWithReasoning (from deepseek.ts) extends this stub.
      class FakeChatDeepSeek {
        constructor(_fields: unknown) {}
        invoke = sinon.stub().resolves({ content: 'stub' });
        stream = sinon.stub();
      }

      // esmock the factory module so that its transitive import of
      // @langchain/deepseek resolves to our fake.  We also need to re-import
      // deepseek.ts inside the same esmock scope so that ChatDeepSeekWithReasoning
      // extends FakeChatDeepSeek.
      deepseekMod = await esmock('../../../src/services/llm/deepseek.js', {
        '@langchain/deepseek': { ChatDeepSeek: FakeChatDeepSeek },
        '../../../src/utils/logger.js': { logger: { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() } },
      });

      factoryMod = await esmock('../../../src/services/llm/factory.js', {
        '@langchain/deepseek': { ChatDeepSeek: FakeChatDeepSeek },
        '../../../src/services/llm/deepseek.js': deepseekMod,
        // Prevent env validation from failing — provide minimal stubs
        '../../../src/config/env.js': {
          env: {
            OPENAI_API_KEY: undefined,
            ANTHROPIC_API_KEY: undefined,
            DEEPSEEK_API_KEY: 'sk-test',
            OPENROUTER_API_KEY: undefined,
          },
        },
      });

      const { LlmProviderFactory: RealFactory } = factoryMod;
      const { ChatDeepSeekWithReasoning } = deepseekMod;

      // No constructor overrides — uses the default deepseek constructor
      const factory = new RealFactory({}, { deepseek: 'sk-test' });
      const instance = factory.create('deepseek', 'deepseek-reasoner');

      expect(instance).to.be.instanceOf(ChatDeepSeekWithReasoning);
      expect(instance).to.be.instanceOf(FakeChatDeepSeek);
    });
  });
});
