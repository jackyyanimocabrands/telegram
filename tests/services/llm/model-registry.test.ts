import { describe, it } from 'mocha';
import { expect } from 'chai';
import { getModelConfig, MODEL_REGISTRY } from '../../../src/services/llm/model-registry.js';

describe('model-registry', () => {
  describe('MODEL_REGISTRY', () => {
    it('contains all expected models', () => {
      const expected = [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
      ];
      for (const model of expected) {
        expect(MODEL_REGISTRY).to.have.property(model);
      }
    });
  });

  describe('getModelConfig', () => {
    const knownModels: Array<{ model: string; maxTokens: number }> = [
      { model: 'gpt-4o', maxTokens: 128000 },
      { model: 'gpt-4o-mini', maxTokens: 128000 },
      { model: 'gpt-4-turbo', maxTokens: 128000 },
      { model: 'claude-3-5-sonnet-20241022', maxTokens: 200000 },
      { model: 'claude-3-5-haiku-20241022', maxTokens: 200000 },
      { model: 'claude-3-opus-20240229', maxTokens: 200000 },
    ];

    for (const { model, maxTokens } of knownModels) {
      it(`returns maxTokens=${maxTokens} for ${model}`, () => {
        const config = getModelConfig(model);
        expect(config.maxTokens).to.equal(maxTokens);
      });
    }

    it('returns fallback maxTokens=4096 for unknown model', () => {
      const config = getModelConfig('some-unknown-model-xyz');
      expect(config.maxTokens).to.equal(4096);
    });

    it('does not throw for unknown model', () => {
      expect(() => getModelConfig('totally-unknown')).to.not.throw();
    });
  });
});
