import { ChatDeepSeek } from '@langchain/deepseek';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import type OpenAI from 'openai';

/**
 * Injects `reasoning_content` from AIMessage.additional_kwargs into the
 * serialised OpenAI-format message params so DeepSeek thinking-mode
 * (e.g. deepseek-reasoner) does not return a 400 on multi-turn conversations.
 *
 * The DeepSeek API requires that when an assistant message was produced with
 * reasoning_content, that same field must be passed back on subsequent turns.
 * @langchain/openai's converter omits it, so we inject it here.
 */
function injectReasoningContent(
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
        // Cast through unknown — reasoning_content is a DeepSeek extension
        // not present in the base OpenAI type.
        return { ...param, reasoning_content: reasoning } as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam;
      }
    }
    return param;
  });
}

/**
 * Drop-in replacement for ChatDeepSeek that correctly handles multi-turn
 * conversations with the `deepseek-reasoner` thinking model.
 *
 * DeepSeek's thinking-mode API returns `reasoning_content` in assistant
 * messages and requires it to be echoed back on subsequent turns. This class
 * overrides `completionWithRetry` to inject the stored `reasoning_content`
 * (from `AIMessage.additional_kwargs`) into the already-serialised message
 * params just before the HTTP request is dispatched.
 */
export class ChatDeepSeekWithReasoning extends ChatDeepSeek {
  /**
   * Holds the original BaseMessage[] for the duration of a _generate /
   * _streamResponseChunks call so that completionWithRetry can access the
   * additional_kwargs that contain reasoning_content.
   */
  private _pendingMessages: BaseMessage[] = [];

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this._pendingMessages = messages;
    try {
      return await super._generate(messages, options, runManager);
    } finally {
      this._pendingMessages = [];
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this._pendingMessages = messages;
    try {
      yield* super._streamResponseChunks(messages, options, runManager);
    } finally {
      this._pendingMessages = [];
    }
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
    if (this._pendingMessages.length > 0 && Array.isArray(request.messages)) {
      request = {
        ...request,
        messages: injectReasoningContent(this._pendingMessages, request.messages),
      };
    }
    // Cast needed because overload resolution on super doesn't narrow here
    return super.completionWithRetry(request as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, requestOptions) as Promise<OpenAI.Chat.Completions.ChatCompletion | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
  }
}
