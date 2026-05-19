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

  // --- Turn 3: simulate reloaded history with incomplete tool-call sequence ---
  //
  // When conversation history is loaded from the DB, ToolMessage entries may be
  // absent (the persistence layer drops them).  The sanitiseToolCallSequences
  // function should silently strip the incomplete group so DeepSeek never sees
  // an assistant+tool_calls without its matching tool responses.
  console.log('\n--- Turn 3: incomplete tool-call sequence (sanitiser smoke test) ---');

  // We call completionWithRetry directly so we can inject the synthetic
  // incomplete messages array without going through LangChain's serialiser.
  const incompleteMessages = [
    { role: 'user' as const, content: 'Please call my_tool for me.' },
    {
      role: 'assistant' as const,
      content: null as unknown as string,
      tool_calls: [
        {
          id: 'tc-smoke-1',
          type: 'function' as const,
          function: { name: 'my_tool', arguments: '{}' },
        },
      ],
    },
    // No tool message — simulates what the DB reload produces
    { role: 'user' as const, content: 'What is 2+2?' },
  ];

  // completionWithRetry is public on the class — call it directly
  const turn3Response = await (model as unknown as {
    completionWithRetry(req: {
      stream: false;
      model: string;
      messages: typeof incompleteMessages;
    }): Promise<{ choices: Array<{ message: { content: string } }> }>;
  }).completionWithRetry({
    stream: false,
    model: 'deepseek-reasoner',
    messages: incompleteMessages,
  });

  const turn3Content = turn3Response.choices?.[0]?.message?.content ?? '(no content)';
  console.log('Turn 3 content:', turn3Content);
  console.log('✓ Turn 3 completed — sanitiser dropped the incomplete tool-call group, no 400 thrown.');
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  console.error('FAILED:', err);
  process.exit(1);
});
