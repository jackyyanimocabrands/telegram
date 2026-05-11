import { describe, it } from 'mocha';
import { expect } from 'chai';
import { LlmProviderFactory } from '../../../src/services/llm/factory.js';
import { OpenAiProvider } from '../../../src/services/llm/openai.js';
import { AnthropicProvider } from '../../../src/services/llm/anthropic.js';

describe('LlmProviderFactory', () => {
  const factory = new LlmProviderFactory();

  describe('create', () => {
    it('returns an OpenAiProvider for provider "openai"', () => {
      const provider = factory.create('openai', 'gpt-4o');
      expect(provider).to.be.instanceOf(OpenAiProvider);
    });

    it('returns an AnthropicProvider for provider "anthropic"', () => {
      const provider = factory.create('anthropic', 'claude-3-5-sonnet-20241022');
      expect(provider).to.be.instanceOf(AnthropicProvider);
    });

    it('throws a descriptive error for an unknown provider', () => {
      expect(() => factory.create('gemini', 'gemini-pro')).to.throw(/Unknown LLM provider.*gemini/);
    });

    it('implements the LlmProvider interface (has complete method)', () => {
      const provider = factory.create('openai', 'gpt-4o');
      expect(provider).to.have.property('complete').that.is.a('function');
    });
  });
});
