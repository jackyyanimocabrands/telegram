import type { LlmMessage } from './provider.js';

/**
 * Rough token estimate: sum of all content lengths divided by 4.
 * Never throws.
 */
export function estimateTokens(messages: LlmMessage[]): number {
  if (messages.length === 0) return 0;
  let total = 0;
  for (const msg of messages) {
    if (msg.content) {
      total += msg.content.length;
    }
  }
  return Math.floor(total / 4);
}
