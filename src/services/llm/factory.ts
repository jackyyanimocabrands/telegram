import { env } from '../../config/env.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiProvider } from './openai.js';
import type { LlmProvider } from './provider.js';

export interface ILlmProviderFactory {
  create(provider: string, model: string): LlmProvider;
}

export class LlmProviderFactory implements ILlmProviderFactory {
  private readonly cache = new Map<string, LlmProvider>();

  create(provider: string, model: string): LlmProvider {
    const cacheKey = `${provider}\0${model}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let instance: LlmProvider;

    switch (provider) {
      case 'openai':
        if (!env.OPENAI_API_KEY) {
          throw new Error('OpenAI API key is not configured');
        }
        instance = new OpenAiProvider(env.OPENAI_API_KEY, model);
        break;
      case 'anthropic':
        if (!env.ANTHROPIC_API_KEY) {
          throw new Error('Anthropic API key is not configured');
        }
        instance = new AnthropicProvider(env.ANTHROPIC_API_KEY, model);
        break;
      default:
        throw new Error(`Unknown LLM provider: "${provider}". Supported providers: openai, anthropic`);
    }

    this.cache.set(cacheKey, instance);
    return instance;
  }
}
