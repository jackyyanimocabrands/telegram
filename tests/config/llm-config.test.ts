/**
 * Unit tests for LlmConfigSchema / SummarizationConfigSchema in llm-config.ts.
 * Uses LlmConfigSchema.parse() directly with fixture objects — no file I/O.
 */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { LlmConfigSchema } from '../../src/config/llm-config.js';

// Minimal valid base fixture (no summarizationConfig key)
const BASE_FIXTURE = {
  chat: [{ provider: 'openai', model: 'gpt-4o', temperature: 0.7 }],
  summarization: [{ provider: 'openai', model: 'gpt-4o-mini', temperature: 0.3 }],
};

describe('SummarizationConfig', () => {
  it('applies all three defaults when summarizationConfig is absent', () => {
    const result = LlmConfigSchema.parse(BASE_FIXTURE);
    expect(result.summarizationConfig.threshold).to.equal(0.8);
    expect(result.summarizationConfig.compression).to.equal(0.5);
    expect(result.summarizationConfig.forceCompression).to.equal(0.75);
  });

  it('applies all three defaults when summarizationConfig is an empty object', () => {
    const result = LlmConfigSchema.parse({ ...BASE_FIXTURE, summarizationConfig: {} });
    expect(result.summarizationConfig.threshold).to.equal(0.8);
    expect(result.summarizationConfig.compression).to.equal(0.5);
    expect(result.summarizationConfig.forceCompression).to.equal(0.75);
  });

  it('returns exact values when all three fields are explicitly provided', () => {
    const result = LlmConfigSchema.parse({
      ...BASE_FIXTURE,
      summarizationConfig: { threshold: 0.6, compression: 0.3, forceCompression: 0.9 },
    });
    expect(result.summarizationConfig.threshold).to.equal(0.6);
    expect(result.summarizationConfig.compression).to.equal(0.3);
    expect(result.summarizationConfig.forceCompression).to.equal(0.9);
  });

  it('applies missing field defaults when only some fields are provided', () => {
    const result = LlmConfigSchema.parse({
      ...BASE_FIXTURE,
      summarizationConfig: { threshold: 0.7 },
    });
    expect(result.summarizationConfig.threshold).to.equal(0.7);
    expect(result.summarizationConfig.compression).to.equal(0.5);
    expect(result.summarizationConfig.forceCompression).to.equal(0.75);
  });

  it('accepts threshold: 1.0 (max boundary)', () => {
    const result = LlmConfigSchema.parse({
      ...BASE_FIXTURE,
      summarizationConfig: { threshold: 1.0 },
    });
    expect(result.summarizationConfig.threshold).to.equal(1.0);
  });

  it('rejects threshold: -0.01 (below min)', () => {
    expect(() =>
      LlmConfigSchema.parse({
        ...BASE_FIXTURE,
        summarizationConfig: { threshold: -0.01 },
      }),
    ).to.throw();
  });

  it('rejects threshold: 1.01 (above max)', () => {
    expect(() =>
      LlmConfigSchema.parse({
        ...BASE_FIXTURE,
        summarizationConfig: { threshold: 1.01 },
      }),
    ).to.throw();
  });

  it('accepts forceCompression: 1.0 (max boundary)', () => {
    const result = LlmConfigSchema.parse({
      ...BASE_FIXTURE,
      summarizationConfig: { forceCompression: 1.0 },
    });
    expect(result.summarizationConfig.forceCompression).to.equal(1.0);
  });

  // T6: boundary rejection tests — values that must be rejected by gt(0) / max(1) constraints
  it('rejects threshold: -0.01 (below gt(0) lower bound)', () => {
    expect(() =>
      LlmConfigSchema.parse({
        ...BASE_FIXTURE,
        summarizationConfig: { threshold: -0.01, compression: 0.5, forceCompression: 0.75 },
      }),
    ).to.throw();
  });

  it('rejects compression: -0.01 (below gt(0) lower bound)', () => {
    expect(() =>
      LlmConfigSchema.parse({
        ...BASE_FIXTURE,
        summarizationConfig: { threshold: 0.8, compression: -0.01, forceCompression: 0.75 },
      }),
    ).to.throw();
  });

  it('rejects forceCompression: 1.01 (above max(1))', () => {
    expect(() =>
      LlmConfigSchema.parse({
        ...BASE_FIXTURE,
        summarizationConfig: { threshold: 0.8, compression: 0.5, forceCompression: 1.01 },
      }),
    ).to.throw();
  });

  // Zero-value rejections — gt(0) means 0.0 is NOT allowed
  it('rejects threshold: 0.0 (gt(0) excludes zero)', () => {
    expect(() =>
      LlmConfigSchema.parse({
        ...BASE_FIXTURE,
        summarizationConfig: { threshold: 0.0, compression: 0.5, forceCompression: 0.75 },
      }),
    ).to.throw();
  });

  it('rejects compression: 0.0 (gt(0) excludes zero)', () => {
    expect(() =>
      LlmConfigSchema.parse({
        ...BASE_FIXTURE,
        summarizationConfig: { threshold: 0.8, compression: 0.0, forceCompression: 0.75 },
      }),
    ).to.throw();
  });

  it('rejects forceCompression: 0.0 (gt(0) excludes zero)', () => {
    expect(() =>
      LlmConfigSchema.parse({
        ...BASE_FIXTURE,
        summarizationConfig: { threshold: 0.8, compression: 0.5, forceCompression: 0.0 },
      }),
    ).to.throw();
  });
});
