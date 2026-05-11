import { logger } from '../../utils/logger.js';
import type { LlmMessage, LlmOptions, LlmProvider } from './provider.js';

export class OpenAiProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  async complete(messages: LlmMessage[], options?: LlmOptions): Promise<string> {
    logger.debug({ model: this.model, messageCount: messages.length }, 'OpenAI request start');

    const response = await this.fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: options?.maxTokens ?? 1024,
        temperature: options?.temperature ?? 0.7,
      }),
    });

    const data = await response.json() as {
      choices?: Array<{ message: { content: string } }>;
      error?: { message: string };
    };

    if (!response.ok || !data.choices || data.choices.length === 0) {
      throw new Error(`OpenAI API error: ${response.status} ${data.error?.message ?? 'unknown'}`);
    }

    const content = data.choices[0]!.message.content;
    logger.debug({ model: this.model, messageCount: messages.length }, 'OpenAI request complete');

    return content;
  }
}
