import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatOpenAI as ChatOpenRouter } from '@langchain/openai';
import { env } from '../../config/env.js';

export interface ILlmProviderFactory {
  create(provider: string, model: string): Pick<BaseChatModel, 'invoke' | 'stream'>;
}

// Injectable constructors for test isolation
export interface ModelConstructors {
  ChatOpenAI: typeof ChatOpenAI;
  ChatAnthropic: typeof ChatAnthropic;
  ChatDeepSeek: typeof ChatDeepSeek;
  ChatOpenRouter: typeof ChatOpenRouter;
}

// Injectable env keys for test isolation
export interface ApiKeys {
  openai?: string;
  anthropic?: string;
  deepseek?: string;
  openrouter?: string;
}

const defaultConstructors: ModelConstructors = {
  ChatOpenAI,
  ChatAnthropic,
  ChatDeepSeek,
  ChatOpenRouter,
};

export class LlmProviderFactory implements ILlmProviderFactory {
  private readonly cache = new Map<string, Pick<BaseChatModel, 'invoke' | 'stream'>>();
  private readonly ctors: ModelConstructors;
  private readonly keys: ApiKeys;

  constructor(ctors: Partial<ModelConstructors> = {}, keys: ApiKeys = {}) {
    this.ctors = { ...defaultConstructors, ...ctors };
    this.keys = {
      openai:     'openai'     in keys ? keys.openai     : env.OPENAI_API_KEY,
      anthropic:  'anthropic'  in keys ? keys.anthropic  : env.ANTHROPIC_API_KEY,
      deepseek:   'deepseek'   in keys ? keys.deepseek   : env.DEEPSEEK_API_KEY,
      openrouter: 'openrouter' in keys ? keys.openrouter : env.OPENROUTER_API_KEY,
    };
  }

  create(provider: string, model: string): Pick<BaseChatModel, 'invoke' | 'stream'> {
    const cacheKey = `${provider}\0${model}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let instance: Pick<BaseChatModel, 'invoke' | 'stream'>;

    switch (provider) {
      case 'openai':
        if (!this.keys.openai) throw new Error('OpenAI API key is not configured');
        instance = new this.ctors.ChatOpenAI({ apiKey: this.keys.openai, model });
        break;

      case 'anthropic':
        if (!this.keys.anthropic) throw new Error('Anthropic API key is not configured');
        instance = new this.ctors.ChatAnthropic({ apiKey: this.keys.anthropic, model });
        break;

      case 'deepseek':
        if (!this.keys.deepseek) throw new Error('DeepSeek API key is not configured');
        instance = new this.ctors.ChatDeepSeek({ apiKey: this.keys.deepseek, model });
        break;

      case 'openrouter':
        if (!this.keys.openrouter) throw new Error('OpenRouter API key is not configured');
        instance = new this.ctors.ChatOpenRouter({
          apiKey: this.keys.openrouter,
          model,
          configuration: { baseURL: 'https://openrouter.ai/api/v1' },
        });
        break;

      default:
        throw new Error(`Unknown LLM provider: "${provider}". Supported providers: openai, anthropic, deepseek, openrouter`);
    }

    this.cache.set(cacheKey, instance);
    return instance;
  }
}
