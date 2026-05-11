import { logger } from '../../utils/logger.js';
import type { LlmMessage, LlmOptions, LlmProvider } from './provider.js';

export class AnthropicProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async complete(messages: LlmMessage[], options?: LlmOptions): Promise<string> {
    logger.debug({ model: this.model, messageCount: messages.length }, 'Anthropic request start');

    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options?.maxTokens ?? 1024,
      messages: conversationMessages,
    };

    if (systemMessage) {
      body['system'] = systemMessage.content;
    }

    const response = await this.fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as {
      content?: Array<{ text: string }>;
      error?: { message: string };
    };

    if (!response.ok || !data.content || data.content.length === 0) {
      throw new Error(`Anthropic API error: ${response.status} ${data.error?.message ?? 'unknown'}`);
    }

    const text = data.content[0]!.text;
    logger.debug({ model: this.model, messageCount: messages.length }, 'Anthropic request complete');

    return text;
  }
}
