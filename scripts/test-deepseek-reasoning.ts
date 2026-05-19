#!/usr/bin/env npx tsx
/**
 * Ad-hoc live API test for ChatDeepSeekWithReasoning.
 *
 * Verifies that multi-turn conversations with deepseek-reasoner work without
 * the 400 "reasoning_content must be passed back" error.
 *
 * Usage:
 *   npx tsx scripts/test-deepseek-reasoning.ts
 *
 * Requires DEEPSEEK_API_KEY in environment (or .env file).
 */

import 'dotenv/config';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { ChatDeepSeekWithReasoning } from '../src/services/llm/deepseek.js';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('ERROR: DEEPSEEK_API_KEY is not set');
  process.exit(1);
}

async function main(): Promise<void> {
  const model = new ChatDeepSeekWithReasoning({
    apiKey,
    model: 'deepseek-reasoner',
  });

  // --- Turn 1 ---
  console.log('--- Turn 1: sending first message ---');
  const firstUserMessage = new HumanMessage('What is 1+1? Think step by step.');

  const turn1Response = await model.invoke([firstUserMessage]);
  const turn1Content = typeof turn1Response.content === 'string'
    ? turn1Response.content
    : JSON.stringify(turn1Response.content);
  const turn1Reasoning = turn1Response.additional_kwargs?.reasoning_content as string | undefined;

  console.log('Turn 1 content:', turn1Content);
  console.log('Turn 1 reasoning_content:', turn1Reasoning ?? '(none)');

  // --- Turn 2 (multi-turn — passes back the assistant message with reasoning_content) ---
  console.log('\n--- Turn 2: sending follow-up with history ---');

  // Reconstruct the assistant AIMessage with reasoning_content preserved
  const assistantMessage = new AIMessage({
    content: turn1Content,
    additional_kwargs: turn1Reasoning ? { reasoning_content: turn1Reasoning } : {},
  });

  const messages = [
    firstUserMessage,
    assistantMessage,
    new HumanMessage('Are you sure about that answer?'),
  ];

  const turn2Response = await model.invoke(messages);
  const turn2Content = typeof turn2Response.content === 'string'
    ? turn2Response.content
    : JSON.stringify(turn2Response.content);
  const turn2Reasoning = turn2Response.additional_kwargs?.reasoning_content as string | undefined;

  console.log('Turn 2 content:', turn2Content);
  console.log('Turn 2 reasoning_content:', turn2Reasoning ?? '(none)');

  console.log('\n✓ Multi-turn conversation completed successfully — no 400 error.');
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  console.error('FAILED:', err);
  process.exit(1);
});
