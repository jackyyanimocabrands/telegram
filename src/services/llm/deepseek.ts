import { AsyncLocalStorage } from 'node:async_hooks';
import { ChatDeepSeek } from '@langchain/deepseek';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import type OpenAI from 'openai';
import { logger } from '../../utils/logger.js';

/**
 * Strips incomplete tool-call groups from a serialised OpenAI messages array.
 *
 * DeepSeek returns 400 when an assistant message with `tool_calls` is not
 * immediately followed by `tool` role messages covering every `tool_call_id`.
 * This happens when conversation history is reloaded from the DB and the
 * `ToolMessage` entries were not persisted.
 *
 * Rules:
 * - An assistant message with a non-empty `tool_calls` array whose immediately
 *   following `tool` messages do NOT cover all expected `tool_call_id`s is
 *   dropped together with those partial tool messages.
 * - A complete group (all tool_call_ids answered) is kept intact.
 * - An assistant message with no `tool_calls` / empty `tool_calls` is untouched.
 * - A `tool` message that appears without a preceding assistant+tool_calls is
 *   dropped — orphan tool messages cause DeepSeek to return 400.
 */
export function sanitizeToolCallSequences(
  params: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  let i = 0;

  while (i < params.length) {
    const param = params[i];

    // Detect an assistant message with at least one tool_call
    if (
      param.role === 'assistant' &&
      'tool_calls' in param &&
      Array.isArray(param.tool_calls) &&
      param.tool_calls.length > 0
    ) {
      const expectedIds = new Set<string>(
        param.tool_calls
          .map((tc: { id?: string }) => tc.id)
          .filter((id): id is string => typeof id === 'string'),
      );

      // Collect immediately following tool-role messages
      const toolMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      let j = i + 1;
      while (j < params.length && params[j].role === 'tool') {
        toolMessages.push(params[j]);
        j++;
      }

      // Check whether every expected tool_call_id is answered
      const answeredIds = new Set<string>(
        toolMessages
          .map((tm) => ('tool_call_id' in tm ? (tm as { tool_call_id?: string }).tool_call_id : undefined))
          .filter((id): id is string => typeof id === 'string'),
      );

      const isComplete = expectedIds.size > 0 && [...expectedIds].every((id) => answeredIds.has(id));

      if (isComplete) {
        // Keep the assistant message and all its tool responses
        result.push(param);
        result.push(...toolMessages);
      }
      // If incomplete — silently drop the assistant message and any partial tool messages

      i = j; // advance past both assistant and tool messages
    } else {
      // Drop orphan tool messages — tool messages without a preceding complete
      // assistant+tool_calls group cause DeepSeek 400.
      if (param.role !== 'tool') {
        result.push(param);
      }
      i++;
    }
  }

  return result;
}

/** Maximum byte length for injected reasoning_content (32 KB). */
const MAX_REASONING_CONTENT_LENGTH = 32_768;

/**
 * Injects `reasoning_content` from AIMessage.additional_kwargs into the
 * serialised OpenAI-format message params so DeepSeek thinking-mode
 * (e.g. deepseek-reasoner) does not return a 400 on multi-turn conversations.
 *
 * The DeepSeek API requires that when an assistant message was produced with
 * reasoning_content, that same field must be passed back on subsequent turns.
 * @langchain/openai's converter omits it, so we inject it here.
 *
 * Safety:
 * - Null bytes (`\0`) are stripped from the value before injection.
 * - Values exceeding MAX_REASONING_CONTENT_LENGTH chars are truncated and
 *   a warning is emitted.
 */
export function injectReasoningContent(
  originalMessages: BaseMessage[],
  mappedParams: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  // Collect AIMessages in their original order so we can match by position
  // against assistant entries in mappedParams.
  const aiMessages = originalMessages.filter(
    (m): m is AIMessage => AIMessage.isInstance(m),
  );

  let aiIdx = 0;
  return mappedParams.map((param) => {
    if (param.role === 'assistant') {
      const src = aiMessages[aiIdx++];
      const reasoning = src?.additional_kwargs?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        // Strip null bytes then enforce size cap
        const sanitized = reasoning.replace(/\0/g, '');
        const safe = sanitized.slice(0, MAX_REASONING_CONTENT_LENGTH);
        if (safe.length < reasoning.length) {
          logger.warn(
            { originalLength: reasoning.length },
            'deepseek: reasoning_content truncated before injection',
          );
        }
        // Cast through unknown — reasoning_content is a DeepSeek extension
        // not present in the base OpenAI type.
        return { ...param, reasoning_content: safe } as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam;
      }
    }
    return param;
  });
}

// ---------------------------------------------------------------------------
// Module-level AsyncLocalStorage — one store shared across all instances.
// Each async call chain (from _generate / _streamResponseChunks) runs in its
// own context, so concurrent jobs on the same cached instance each see only
// their own BaseMessage[].
// ---------------------------------------------------------------------------
const _messagesStorage = new AsyncLocalStorage<BaseMessage[]>();

/**
 * Drop-in replacement for ChatDeepSeek that correctly handles multi-turn
 * conversations with the `deepseek-reasoner` thinking model.
 *
 * DeepSeek's thinking-mode API returns `reasoning_content` in assistant
 * messages and requires it to be echoed back on subsequent turns. This class
 * overrides `completionWithRetry` to inject the stored `reasoning_content`
 * (from `AIMessage.additional_kwargs`) into the already-serialised message
 * params just before the HTTP request is dispatched.
 *
 * Concurrency safety: `AsyncLocalStorage` scopes each call's BaseMessage[]
 * to its own async context, eliminating the data race that affected the
 * previous `_pendingMessages` instance-field approach when the same cached
 * instance served concurrent BullMQ jobs.
 */
export class ChatDeepSeekWithReasoning extends ChatDeepSeek {
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    // Run super._generate inside an AsyncLocalStorage context so that
    // completionWithRetry (called deeper in the chain) can retrieve the
    // original messages without any instance-level state.
    return _messagesStorage.run(messages, () =>
      super._generate(messages, options, runManager),
    );
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    // Collect the parent generator inside the run() context so that
    // completionWithRetry (called by the parent during iteration) sees
    // the correct messages in _messagesStorage. Re-yield chunks outside
    // the run() scope — chunk objects themselves carry no storage reference.
    //
    // Tradeoffs:
    // - This buffers all chunks in memory before yielding them to the caller.
    //   For typical DeepSeek response sizes this is acceptable (a few KB of
    //   text chunks). The alternative (true streaming) would require enterWith()
    //   which carries a context-leakage risk: enterWith() mutates the async
    //   context of the generator's async resource and does NOT have a bounded
    //   lifetime, potentially contaminating sibling async resources in concurrent
    //   streaming calls on the same cached instance.
    // - The storage context is properly scoped: completionWithRetry is called
    //   within the run() callback and sees the correct messages.
    // - Error propagation is preserved via the streamError variable.
    const chunks: ChatGenerationChunk[] = [];
    let streamError: unknown;

    await _messagesStorage.run(messages, async () => {
      try {
        for await (const chunk of super._streamResponseChunks(messages, options, runManager)) {
          chunks.push(chunk);
        }
      } catch (err) {
        streamError = err;
      }
    });

    if (streamError !== undefined) throw streamError;
    yield* chunks;
  }

  // Overload signatures matching parent class
  override completionWithRetry(
    request: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    requestOptions?: OpenAI.RequestOptions,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
  override completionWithRetry(
    request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    requestOptions?: OpenAI.RequestOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
  override completionWithRetry(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    requestOptions?: OpenAI.RequestOptions,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    if (Array.isArray(request.messages)) {
      const originalMessages = _messagesStorage.getStore() ?? [];
      const injected = originalMessages.length > 0
        ? injectReasoningContent(originalMessages, request.messages)
        : request.messages;
      request = {
        ...request,
        messages: sanitizeToolCallSequences(injected),
      };
    }
    // Cast needed because overload resolution on super doesn't narrow here
    return super.completionWithRetry(
      request as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      requestOptions,
    ) as Promise<OpenAI.Chat.Completions.ChatCompletion | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
  }
}
