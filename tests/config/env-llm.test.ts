import { describe, it } from 'mocha';
import { expect } from 'chai';
import { z } from 'zod';

/**
 * Re-create the LLM-relevant slice of the env schema for unit testing validation rules.
 * We test the superRefine logic in isolation without importing the live env module
 * (which is already parsed at module load time).
 */
const llmEnvSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEFAULT_LLM_PROVIDER: z.enum(['openai', 'anthropic']).default('openai'),
  DEFAULT_LLM_MODEL: z.string().default('gpt-4o'),
  DEFAULT_SUMMARIZATION_PROVIDER: z.enum(['openai', 'anthropic']).default('openai'),
  DEFAULT_SUMMARIZATION_MODEL: z.string().default('gpt-4o-mini'),
  FALLBACK_LLM_PROVIDER: z.enum(['openai', 'anthropic']).optional(),
  FALLBACK_LLM_MODEL: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.DEFAULT_LLM_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENAI_API_KEY'], message: 'OPENAI_API_KEY is required when DEFAULT_LLM_PROVIDER is "openai"' });
  }
  if (data.DEFAULT_LLM_PROVIDER === 'anthropic' && !data.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ANTHROPIC_API_KEY'], message: 'ANTHROPIC_API_KEY is required when DEFAULT_LLM_PROVIDER is "anthropic"' });
  }
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENAI_API_KEY'], message: 'OPENAI_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "openai"' });
  }
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'anthropic' && !data.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ANTHROPIC_API_KEY'], message: 'ANTHROPIC_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "anthropic"' });
  }
  const hasProvider = data.FALLBACK_LLM_PROVIDER !== undefined;
  const hasModel = data.FALLBACK_LLM_MODEL !== undefined;
  if (hasProvider && !hasModel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FALLBACK_LLM_MODEL'], message: 'FALLBACK_LLM_MODEL is required when FALLBACK_LLM_PROVIDER is set' });
  }
  if (hasModel && !hasProvider) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FALLBACK_LLM_PROVIDER'], message: 'FALLBACK_LLM_PROVIDER is required when FALLBACK_LLM_MODEL is set' });
  }
});

describe('env — LLM configuration validation', () => {
  describe('valid configurations', () => {
    it('passes with openai provider and OPENAI_API_KEY set', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openai',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
      });
      expect(result.success).to.be.true;
    });

    it('passes with anthropic provider and ANTHROPIC_API_KEY set', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'anthropic',
        DEFAULT_SUMMARIZATION_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      });
      expect(result.success).to.be.true;
    });

    it('passes with both fallback provider and model set', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openai',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        FALLBACK_LLM_PROVIDER: 'anthropic',
        FALLBACK_LLM_MODEL: 'claude-3-5-haiku-20241022',
      });
      expect(result.success).to.be.true;
    });

    it('passes when neither fallback provider nor model is set', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openai',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
      });
      expect(result.success).to.be.true;
    });

    it('applies default values correctly', () => {
      const result = llmEnvSchema.safeParse({ OPENAI_API_KEY: 'sk-test' });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.DEFAULT_LLM_PROVIDER).to.equal('openai');
        expect(result.data.DEFAULT_LLM_MODEL).to.equal('gpt-4o');
        expect(result.data.DEFAULT_SUMMARIZATION_PROVIDER).to.equal('openai');
        expect(result.data.DEFAULT_SUMMARIZATION_MODEL).to.equal('gpt-4o-mini');
      }
    });
  });

  describe('missing API key for configured provider', () => {
    it('fails when DEFAULT_LLM_PROVIDER is "openai" but OPENAI_API_KEY is missing', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openai',
        DEFAULT_SUMMARIZATION_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-ant-test',
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('OPENAI_API_KEY');
      }
    });

    it('fails when DEFAULT_LLM_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is missing', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'anthropic',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('ANTHROPIC_API_KEY');
      }
    });

    it('fails when DEFAULT_SUMMARIZATION_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is missing', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openai',
        DEFAULT_SUMMARIZATION_PROVIDER: 'anthropic',
        OPENAI_API_KEY: 'sk-test',
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('ANTHROPIC_API_KEY');
      }
    });
  });

  describe('partial fallback configuration', () => {
    it('fails when FALLBACK_LLM_PROVIDER is set but FALLBACK_LLM_MODEL is missing', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openai',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        FALLBACK_LLM_PROVIDER: 'anthropic',
        // FALLBACK_LLM_MODEL intentionally omitted
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('FALLBACK_LLM_MODEL');
      }
    });

    it('fails when FALLBACK_LLM_MODEL is set but FALLBACK_LLM_PROVIDER is missing', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openai',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        FALLBACK_LLM_MODEL: 'claude-3-5-haiku-20241022',
        // FALLBACK_LLM_PROVIDER intentionally omitted
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('FALLBACK_LLM_PROVIDER');
      }
    });
  });
});
