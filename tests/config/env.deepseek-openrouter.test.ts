import { describe, it } from 'mocha';
import { expect } from 'chai';
import { z } from 'zod';

/**
 * Tests for the new DeepSeek and OpenRouter superRefine rules in env.ts.
 *
 * We replicate the relevant slice of the schema here to avoid importing the live
 * env module (which parses process.env at import time and may call process.exit).
 *
 * The schema slice covers:
 *   - DEFAULT_LLM_PROVIDER (extended to deepseek | openrouter)
 *   - DEFAULT_SUMMARIZATION_PROVIDER (extended to deepseek | openrouter)
 *   - FALLBACK_LLM_PROVIDER (extended to deepseek | openrouter)
 *   - All four API key checks
 */

const llmEnvSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  DEFAULT_LLM_PROVIDER: z.enum(['openai', 'anthropic', 'deepseek', 'openrouter']).default('openai'),
  DEFAULT_LLM_MODEL: z.string().default('gpt-4o'),
  DEFAULT_SUMMARIZATION_PROVIDER: z.enum(['openai', 'anthropic', 'deepseek', 'openrouter']).default('openai'),
  DEFAULT_SUMMARIZATION_MODEL: z.string().default('gpt-4o-mini'),
  FALLBACK_LLM_PROVIDER: z.enum(['openai', 'anthropic', 'deepseek', 'openrouter']).optional(),
  FALLBACK_LLM_MODEL: z.string().optional(),
}).superRefine((data, ctx) => {
  // DEFAULT_LLM_PROVIDER key requirements
  if (data.DEFAULT_LLM_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENAI_API_KEY'], message: 'OPENAI_API_KEY is required when DEFAULT_LLM_PROVIDER is "openai"' });
  }
  if (data.DEFAULT_LLM_PROVIDER === 'anthropic' && !data.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ANTHROPIC_API_KEY'], message: 'ANTHROPIC_API_KEY is required when DEFAULT_LLM_PROVIDER is "anthropic"' });
  }
  if (data.DEFAULT_LLM_PROVIDER === 'deepseek' && !data.DEEPSEEK_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DEEPSEEK_API_KEY'], message: 'DEEPSEEK_API_KEY is required when DEFAULT_LLM_PROVIDER is "deepseek"' });
  }
  if (data.DEFAULT_LLM_PROVIDER === 'openrouter' && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENROUTER_API_KEY'], message: 'OPENROUTER_API_KEY is required when DEFAULT_LLM_PROVIDER is "openrouter"' });
  }
  // DEFAULT_SUMMARIZATION_PROVIDER key requirements
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENAI_API_KEY'], message: 'OPENAI_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "openai"' });
  }
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'anthropic' && !data.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ANTHROPIC_API_KEY'], message: 'ANTHROPIC_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "anthropic"' });
  }
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'deepseek' && !data.DEEPSEEK_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DEEPSEEK_API_KEY'], message: 'DEEPSEEK_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "deepseek"' });
  }
  if (data.DEFAULT_SUMMARIZATION_PROVIDER === 'openrouter' && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENROUTER_API_KEY'], message: 'OPENROUTER_API_KEY is required when DEFAULT_SUMMARIZATION_PROVIDER is "openrouter"' });
  }
  // FALLBACK must be both or neither
  const hasProvider = data.FALLBACK_LLM_PROVIDER !== undefined;
  const hasModel = data.FALLBACK_LLM_MODEL !== undefined;
  if (hasProvider && !hasModel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FALLBACK_LLM_MODEL'], message: 'FALLBACK_LLM_MODEL is required when FALLBACK_LLM_PROVIDER is set' });
  }
  if (hasModel && !hasProvider) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FALLBACK_LLM_PROVIDER'], message: 'FALLBACK_LLM_PROVIDER is required when FALLBACK_LLM_MODEL is set' });
  }
  // FALLBACK_LLM_PROVIDER API key requirements
  if (data.FALLBACK_LLM_PROVIDER === 'deepseek' && !data.DEEPSEEK_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'DEEPSEEK_API_KEY is required when FALLBACK_LLM_PROVIDER is deepseek', path: ['DEEPSEEK_API_KEY'] });
  }
  if (data.FALLBACK_LLM_PROVIDER === 'openrouter' && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'OPENROUTER_API_KEY is required when FALLBACK_LLM_PROVIDER is openrouter', path: ['OPENROUTER_API_KEY'] });
  }
});

// Helper: a passing base that satisfies the openai default rules
const baseValid = {
  DEFAULT_LLM_PROVIDER: 'openai' as const,
  DEFAULT_SUMMARIZATION_PROVIDER: 'openai' as const,
  OPENAI_API_KEY: 'sk-test',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('env — DeepSeek and OpenRouter superRefine rules', () => {

  // ── DEFAULT_LLM_PROVIDER deepseek ─────────────────────────────────────────

  describe('DEFAULT_LLM_PROVIDER = "deepseek"', () => {
    it('fails with error on DEEPSEEK_API_KEY when key is absent', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'deepseek',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        // DEEPSEEK_API_KEY absent
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('DEEPSEEK_API_KEY');
      }
    });

    it('passes when DEEPSEEK_API_KEY is present', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'deepseek',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        DEEPSEEK_API_KEY: 'ds-key-123',
      });
      expect(result.success).to.be.true;
    });
  });

  // ── DEFAULT_LLM_PROVIDER openrouter ──────────────────────────────────────

  describe('DEFAULT_LLM_PROVIDER = "openrouter"', () => {
    it('fails with error on OPENROUTER_API_KEY when key is absent', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openrouter',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        // OPENROUTER_API_KEY absent
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('OPENROUTER_API_KEY');
      }
    });

    it('passes when OPENROUTER_API_KEY is present', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openrouter',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        OPENROUTER_API_KEY: 'or-key-123',
      });
      expect(result.success).to.be.true;
    });
  });

  // ── DEFAULT_SUMMARIZATION_PROVIDER deepseek ──────────────────────────────

  describe('DEFAULT_SUMMARIZATION_PROVIDER = "deepseek"', () => {
    it('fails with error on DEEPSEEK_API_KEY when key is absent', () => {
      const result = llmEnvSchema.safeParse({
        ...baseValid,
        DEFAULT_SUMMARIZATION_PROVIDER: 'deepseek',
        // DEEPSEEK_API_KEY absent
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('DEEPSEEK_API_KEY');
      }
    });

    it('passes when DEEPSEEK_API_KEY is present', () => {
      const result = llmEnvSchema.safeParse({
        ...baseValid,
        DEFAULT_SUMMARIZATION_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'ds-key-123',
      });
      expect(result.success).to.be.true;
    });
  });

  // ── DEFAULT_SUMMARIZATION_PROVIDER openrouter ────────────────────────────

  describe('DEFAULT_SUMMARIZATION_PROVIDER = "openrouter"', () => {
    it('fails with error on OPENROUTER_API_KEY when key is absent', () => {
      const result = llmEnvSchema.safeParse({
        ...baseValid,
        DEFAULT_SUMMARIZATION_PROVIDER: 'openrouter',
        // OPENROUTER_API_KEY absent
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('OPENROUTER_API_KEY');
      }
    });

    it('passes when OPENROUTER_API_KEY is present', () => {
      const result = llmEnvSchema.safeParse({
        ...baseValid,
        DEFAULT_SUMMARIZATION_PROVIDER: 'openrouter',
        OPENROUTER_API_KEY: 'or-key-123',
      });
      expect(result.success).to.be.true;
    });
  });

  // ── FALLBACK_LLM_PROVIDER deepseek ───────────────────────────────────────

  describe('FALLBACK_LLM_PROVIDER = "deepseek"', () => {
    it('fails when DEEPSEEK_API_KEY is absent (FALLBACK_LLM_MODEL also required)', () => {
      const result = llmEnvSchema.safeParse({
        ...baseValid,
        FALLBACK_LLM_PROVIDER: 'deepseek',
        FALLBACK_LLM_MODEL: 'deepseek-chat',
        // DEEPSEEK_API_KEY absent
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('DEEPSEEK_API_KEY');
      }
    });

    it('passes when DEEPSEEK_API_KEY and FALLBACK_LLM_MODEL are both set', () => {
      const result = llmEnvSchema.safeParse({
        ...baseValid,
        FALLBACK_LLM_PROVIDER: 'deepseek',
        FALLBACK_LLM_MODEL: 'deepseek-chat',
        DEEPSEEK_API_KEY: 'ds-key-123',
      });
      expect(result.success).to.be.true;
    });

    it('fails when FALLBACK_LLM_MODEL is missing (pair rule)', () => {
      const result = llmEnvSchema.safeParse({
        ...baseValid,
        FALLBACK_LLM_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'ds-key-123',
        // FALLBACK_LLM_MODEL absent
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('FALLBACK_LLM_MODEL');
      }
    });
  });

  // ── FALLBACK_LLM_PROVIDER openrouter ─────────────────────────────────────

  describe('FALLBACK_LLM_PROVIDER = "openrouter"', () => {
    it('fails when OPENROUTER_API_KEY is absent', () => {
      const result = llmEnvSchema.safeParse({
        ...baseValid,
        FALLBACK_LLM_PROVIDER: 'openrouter',
        FALLBACK_LLM_MODEL: 'openai/gpt-4o',
        // OPENROUTER_API_KEY absent
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('OPENROUTER_API_KEY');
      }
    });

    it('passes when OPENROUTER_API_KEY and FALLBACK_LLM_MODEL are both set', () => {
      const result = llmEnvSchema.safeParse({
        ...baseValid,
        FALLBACK_LLM_PROVIDER: 'openrouter',
        FALLBACK_LLM_MODEL: 'openai/gpt-4o',
        OPENROUTER_API_KEY: 'or-key-123',
      });
      expect(result.success).to.be.true;
    });
  });

  // ── Enum extension — new values accepted ─────────────────────────────────

  describe('schema enum extension', () => {
    it('accepts "deepseek" as a valid DEFAULT_LLM_PROVIDER value', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'deepseek',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        DEEPSEEK_API_KEY: 'ds-key',
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.DEFAULT_LLM_PROVIDER).to.equal('deepseek');
      }
    });

    it('accepts "openrouter" as a valid DEFAULT_LLM_PROVIDER value', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'openrouter',
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
        OPENROUTER_API_KEY: 'or-key',
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.DEFAULT_LLM_PROVIDER).to.equal('openrouter');
      }
    });

    it('rejects an invalid provider value', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'gemini' as any,
        DEFAULT_SUMMARIZATION_PROVIDER: 'openai',
        OPENAI_API_KEY: 'sk-test',
      });
      expect(result.success).to.be.false;
    });
  });

  // T10: dual-provider deepseek tests
  describe('dual-provider: both LLM and summarization use deepseek', () => {
    it('succeeds when both providers are deepseek and DEEPSEEK_API_KEY is present', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'deepseek',
        DEFAULT_SUMMARIZATION_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'ds-key-123',
      });
      expect(result.success).to.be.true;
    });

    it('fails when both providers are deepseek and DEEPSEEK_API_KEY is absent', () => {
      const result = llmEnvSchema.safeParse({
        DEFAULT_LLM_PROVIDER: 'deepseek',
        DEFAULT_SUMMARIZATION_PROVIDER: 'deepseek',
        // DEEPSEEK_API_KEY absent
      });
      expect(result.success).to.be.false;
      if (!result.success) {
        const fields = result.error.flatten().fieldErrors;
        expect(fields).to.have.property('DEEPSEEK_API_KEY');
      }
    });
  });
});
