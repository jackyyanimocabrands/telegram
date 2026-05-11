import { logger } from '../../utils/logger.js';

export interface ModelConfig {
  maxTokens: number;
}

export const MODEL_REGISTRY: Record<string, ModelConfig> = {
  'gpt-4o': { maxTokens: 128000 },
  'gpt-4o-mini': { maxTokens: 128000 },
  'gpt-4-turbo': { maxTokens: 128000 },
  'claude-3-5-sonnet-20241022': { maxTokens: 200000 },
  'claude-3-5-haiku-20241022': { maxTokens: 200000 },
  'claude-3-opus-20240229': { maxTokens: 200000 },
};

const FALLBACK_CONFIG: ModelConfig = { maxTokens: 4096 };

export function getModelConfig(model: string): ModelConfig {
  const config = MODEL_REGISTRY[model];
  if (!config) {
    logger.warn({ model }, 'Unknown model — falling back to default config');
    return FALLBACK_CONFIG;
  }
  return config;
}
