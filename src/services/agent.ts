import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  BaseMessage,
  RemoveMessage,
} from '@langchain/core/messages';
import {
  StateGraph,
  Annotation,
  MessagesAnnotation,
  START,
  END,
} from '@langchain/langgraph';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { ConversationService, toBaseMessages, fromBaseMessages } from './conversation.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * Minimal factory interface used by the agent graph.
 * Production uses LlmProviderFactory (cast as any at call-site in index.ts);
 * tests inject `{ create: () => ({ invoke: stub }) }` directly.
 */
export interface ILlmModelFactory {
  create(provider: string, model: string): Pick<BaseChatModel, 'invoke' | 'stream'>;
}
import { getModelConfig } from './llm/model-registry.js';
import { estimateTokens } from './llm/token-estimator.js';
import { setConversationSystemPrompt } from '../db/queries/conversations.js';

// ── State annotation ────────────────────────────────────────────────────────

const AgentStateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  // Scalar fields use LastValue semantics (last writer wins) via Annotation<T>()
  // Fields that need a default use { reducer: (_, b) => b, default: () => ... }
  userInput: Annotation<string>({
    reducer: (_a: string, b: string) => b,
    default: () => '',
  }),
  summary: Annotation<string>({
    reducer: (_a: string, b: string) => b,
    default: () => '',
  }),
  botId: Annotation<string>({
    reducer: (_a: string, b: string) => b,
    default: () => '',
  }),
  userId: Annotation<number>({
    reducer: (_a: number, b: number) => b,
    default: () => 0,
  }),
  systemPromptOverride: Annotation<string | undefined>({
    reducer: (_a: string | undefined, b: string | undefined) => b,
    default: () => undefined,
  }),
  provider: Annotation<string>({
    reducer: (_a: string, b: string) => b,
    default: () => '',
  }),
  model: Annotation<string>({
    reducer: (_a: string, b: string) => b,
    default: () => '',
  }),
  summarizationProvider: Annotation<string>({
    reducer: (_a: string, b: string) => b,
    default: () => '',
  }),
  summarizationModel: Annotation<string>({
    reducer: (_a: string, b: string) => b,
    default: () => '',
  }),
});

type AgentState = typeof AgentStateAnnotation.State;

// ── Summary sentinel — used to detect and filter the injected summary message ──

const SUMMARY_PREFIX = 'Previous conversation summary:';

// ── Node: loadHistory ────────────────────────────────────────────────────────

/**
 * TR-2: Exported for unit testing.
 *
 * Loads conversation history from DB and builds the initial message list:
 *   [SystemMessage?] + [summary AIMessage?] + [...historyMessages] + [HumanMessage(userInput)]
 * The new user message (HumanMessage) is appended last from state.userInput.
 */
export async function loadHistoryNode(
  state: AgentState,
  services: { conversationService: ConversationService },
): Promise<Partial<AgentState>> {
  // INVARIANT: state.messages is always [] here because:
  // 1. chat() passes messages:[] in initial state (no HumanMessage seeded)
  // 2. This graph has no checkpointer — no state persists between invocations
  // 3. loadHistoryNode is the first (and only) node that populates messages
  // If a checkpointer is ever added, this node must be redesigned.
  if (state.messages.length !== 0) {
    throw new Error(
      'loadHistoryNode invariant violated: state.messages must be empty at graph entry. ' +
      'This graph is stateless (no checkpointer). If a checkpointer is added, this node must be redesigned.'
    );
  }

  // I8: fail-fast guard — these must always be supplied in the initial graph state
  if (!state.botId) throw new Error('botId must be provided in initial graph state');
  if (!state.userId) throw new Error('userId must be provided in initial graph state');

  const { conversationService } = services;
  const row = await conversationService.load(state.botId, state.userId);

  const builtMessages: BaseMessage[] = [];

  // 1. System prompt
  const systemPrompt = state.systemPromptOverride ?? row.system_prompt ?? null;
  if (systemPrompt) {
    builtMessages.push(new SystemMessage(systemPrompt));
  }

  // 2. Summary injection (sits between system and history)
  if (row.summary !== null && row.summary !== '') {
    builtMessages.push(new AIMessage(`${SUMMARY_PREFIX}\n${row.summary}`));
  }

  // 3. Stored conversation history
  const historyMessages = toBaseMessages(row.messages);
  builtMessages.push(...historyMessages);

  // 4. New user message appended LAST so order is correct:
  //    [System?] + [Summary?] + [...history] + [HumanMessage]
  builtMessages.push(new HumanMessage(state.userInput));

  return {
    messages: builtMessages,
    provider: row.llm_provider,
    model: row.llm_model,
    summarizationProvider: row.summarization_provider,
    summarizationModel: row.summarization_model,
    summary: row.summary ?? '',
  };
}

// ── Node: agent ──────────────────────────────────────────────────────────────

/**
 * TR-2: Exported for unit testing.
 *
 * Invokes the LLM with the full conversation context and returns the AI reply.
 */
export async function agentNode(
  state: AgentState,
  services: { modelFactory: ILlmModelFactory },
): Promise<Partial<AgentState>> {
  const { modelFactory } = services;
  const model = modelFactory.create(state.provider, state.model);
  logger.debug(
    { provider: state.provider, model: state.model, messageCount: state.messages.length },
    'agentNode: invoking LLM',
  );

  const aiMessage = await model.invoke(state.messages) as AIMessage;
  logger.debug({ contentLength: String(aiMessage.content).length }, 'agentNode: got reply');

  return { messages: [aiMessage] };
}

// ── Conditional edge: checkBudgetRouter ─────────────────────────────────────

/**
 * TR-2: Exported for unit testing.
 *
 * Routes to 'summarize' if the conversation is over budget, 'save' otherwise.
 */
export function checkBudgetRouter(state: AgentState): 'summarize' | 'save' {
  const budget = Math.floor(getModelConfig(state.model).maxTokens * 0.8);
  const tokenInput = state.messages.map(m => {
    const type = m.getType();
    const role: 'user' | 'assistant' | 'system' =
      type === 'human' ? 'user' :
      type === 'ai' ? 'assistant' :
      type === 'system' ? 'system' : 'user';
    return {
      role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    };
  });
  const currentTokens = estimateTokens(tokenInput);

  logger.debug({ currentTokens, budget }, 'checkBudgetRouter');

  return currentTokens > budget ? 'summarize' : 'save';
}

// ── Node: summarize ──────────────────────────────────────────────────────────

/**
 * TR-2: Exported for unit testing.
 *
 * Summarizes the oldest half of the conversation history (excluding system messages
 * and the injected summary sentinel). On failure, logs a warning and returns without
 * updating state so the save node still runs.
 */
export async function summarizeNode(
  state: AgentState,
  services: { modelFactory: ILlmModelFactory },
): Promise<Partial<AgentState>> {
  const { modelFactory } = services;

  // History = non-system, non-sentinel messages
  const historyMessages = state.messages.filter(
    m =>
      !(m instanceof SystemMessage) &&
      !(
        m instanceof AIMessage &&
        typeof m.content === 'string' &&
        m.content.startsWith(SUMMARY_PREFIX)
      ),
  );

  const oldestHalfCount = Math.floor(historyMessages.length / 2);
  if (oldestHalfCount === 0) {
    logger.debug('summarizeNode: not enough messages to summarize, skipping');
    return {};
  }

  const messagesToSummarize = historyMessages.slice(0, oldestHalfCount);

  try {
    const model = modelFactory.create(state.summarizationProvider, state.summarizationModel);

    const summarizationMessages = [
      new SystemMessage(
        'You are a conversation summarizer. Summarize the following conversation into 2-3 concise sentences capturing the key points and context. Output only the summary text, no preamble.'
      ),
      ...messagesToSummarize.filter(m => ['human', 'ai'].includes(m.getType())),
      new HumanMessage('Summarize the conversation above into 2-3 concise sentences.'),
    ];
    const summaryResult = await model.invoke(summarizationMessages) as AIMessage;

    const newSummaryText =
      typeof summaryResult.content === 'string'
        ? summaryResult.content
        : JSON.stringify(summaryResult.content);

    logger.info(
      { summarizedCount: oldestHalfCount, summaryLength: newSummaryText.length },
      'summarizeNode: summarization complete',
    );

    // Remove the oldest half from state using RemoveMessage
    const removeMessages = messagesToSummarize
      .filter(m => m.id !== undefined && m.id !== null)
      .map(m => new RemoveMessage({ id: m.id as string }));

    if (removeMessages.length < messagesToSummarize.length) {
      logger.warn(
        { expected: messagesToSummarize.length, actual: removeMessages.length },
        'summarizeNode: some messages lacked IDs and could not be pruned — context window will not shrink as expected',
      );
    }

    return {
      messages: removeMessages,
      summary: newSummaryText,
    };
  } catch (err) {
    logger.warn({ err }, 'summarizeNode: summarization failed, continuing without update');
    return {};
  }
}

// ── Node: save ───────────────────────────────────────────────────────────────

/**
 * TR-2: Exported for unit testing.
 *
 * Persists the conversation history (minus system messages and sentinel) to DB.
 */
export async function saveNode(
  state: AgentState,
  services: { conversationService: ConversationService },
): Promise<Partial<AgentState>> {
  const { conversationService } = services;

  // Filter out: SystemMessage and injected summary sentinel
  const persistMessages = state.messages.filter(
    m =>
      !(m instanceof SystemMessage) &&
      !(
        m instanceof AIMessage &&
        typeof m.content === 'string' &&
        m.content.startsWith(SUMMARY_PREFIX)
      ),
  );

  const conversationMessages = fromBaseMessages(persistMessages);
  await conversationService.save(
    state.botId,
    state.userId,
    conversationMessages,
    state.summary || null,
  );

  logger.debug(
    { botId: state.botId, userId: state.userId, messageCount: conversationMessages.length },
    'saveNode: conversation persisted',
  );

  return {};
}

// ── Graph builder ────────────────────────────────────────────────────────────

/**
 * Build and compile the LangGraph agent graph.
 * Nodes receive injected services via closures — no checkpointer (stateless between turns).
 */
export function buildAgentGraph(
  conversationService: ConversationService,
  modelFactory: ILlmModelFactory,
) {
  const services = { conversationService, modelFactory };

  return new StateGraph(AgentStateAnnotation)
    .addNode('loadHistory', (state: AgentState) => loadHistoryNode(state, services))
    .addNode('agent', (state: AgentState) => agentNode(state, services))
    .addNode('summarize', (state: AgentState) => summarizeNode(state, services))
    .addNode('save', (state: AgentState) => saveNode(state, services))
    .addEdge(START, 'loadHistory')
    .addEdge('loadHistory', 'agent')
    .addConditionalEdges('agent', checkBudgetRouter, { summarize: 'summarize', save: 'save' })
    .addEdge('summarize', 'save')
    .addEdge('save', END)
    .compile();
}

type CompiledGraph = ReturnType<typeof buildAgentGraph>;

// ── AgentService ─────────────────────────────────────────────────────────────

export class AgentService {
  readonly graph: CompiledGraph;

  constructor(
    private readonly conversationService: ConversationService,
    private readonly modelFactory: ILlmModelFactory,
    // TR-5: injectable graph for testing
    graph?: CompiledGraph,
  ) {
    this.graph = graph ?? buildAgentGraph(conversationService, modelFactory);
  }

  /**
   * Core chat entrypoint — runs the LangGraph agent graph for one turn.
   *
   * @param botId               String bot identifier ('manager' or stringified numeric bot id)
   * @param userId              Telegram user id (numeric)
   * @param text                User message text
   * @param systemPromptOverride  Optional system prompt to use instead of stored one
   */
  async chat(
    botId: string,
    userId: number,
    text: string,
    systemPromptOverride?: string,
  ): Promise<string> {
    logger.debug({ botId, userId, textLength: text.length }, 'AgentService.chat: start');

    // userInput carries the new text; messages starts empty so loadHistoryNode
    // controls the full ordering: [System?] + [Summary?] + [...history] + [HumanMessage]
    const initialState = {
      messages: [],
      userInput: text,
      botId,
      userId,
      systemPromptOverride,
    };

    const result = await this.graph.invoke(initialState);

    // Last AI message in result is the reply (excluding the sentinel)
    const msgs = result.messages as BaseMessage[];
    let lastAi: BaseMessage | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (
        m.getType() === 'ai' &&
        !(typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX))
      ) {
        lastAi = m;
        break;
      }
    }

    const reply =
      typeof lastAi?.content === 'string' ? lastAi.content : '';

    logger.debug({ botId, userId, replyLength: reply.length }, 'AgentService.chat: done');
    return reply;
  }

  /**
   * Streaming chat entrypoint — runs the LangGraph agent graph and yields token
   * chunks from the agentNode as they are produced by the LLM.
   *
   * The graph runs to completion (loadHistory → agent → checkBudget → save/summarize).
   * Only tokens from the 'agent' node are yielded; summarization tokens are suppressed.
   *
   * Callers are responsible for assembling the full response and persisting it
   * via sendMessage once streaming is complete.
   *
   * @param botId               String bot identifier ('manager' or stringified numeric bot id)
   * @param userId              Telegram user id (numeric)
   * @param text                User message text
   * @param systemPromptOverride  Optional system prompt to use instead of stored one
   */
  async *chatStream(
    botId: string,
    userId: number,
    text: string,
    systemPromptOverride?: string,
  ): AsyncGenerator<string> {
    logger.debug({ botId, userId, textLength: text.length }, 'AgentService.chatStream: start');

    const initialState = {
      messages: [],
      userInput: text,
      botId,
      userId,
      systemPromptOverride,
    };

    let tokenCount = 0;

    for await (const event of this.graph.streamEvents(initialState, { version: 'v2' })) {
      if (
        event.event === 'on_chat_model_stream' &&
        event.metadata?.langgraph_node === 'agent'
      ) {
        const content = event.data?.chunk?.content;
        const token = typeof content === 'string' ? content : '';
        if (token) {
          tokenCount++;
          yield token;
        }
      }
    }

    logger.debug({ botId, userId, tokenCount }, 'AgentService.chatStream: done');
  }

  /**
   * Clear conversation history and summary for a bot+user pair.
   */
  async clearContext(botId: string, userId: number): Promise<void> {
    logger.info({ botId, userId }, 'AgentService.clearContext');
    await this.conversationService.clearMessages(botId, userId);
  }

  /**
   * Switch the LLM provider and model for a bot+user pair.
   */
  async switchProvider(
    botId: string,
    userId: number,
    provider: string,
    model: string,
  ): Promise<void> {
    logger.info({ botId, userId, provider, model }, 'AgentService.switchProvider');

    // Validate provider is instantiable (will throw for missing API key etc.)
    this.modelFactory.create(provider, model);

    await this.conversationService.updateProvider(botId, userId, provider, model);
    logger.info({ botId, userId, provider, model }, 'AgentService.switchProvider: done');
  }

  /**
   * Generate a warm system prompt for a child bot by distilling the conversation
   * history between the user and the manager bot.
   *
   * Returns null if there is no history or generation fails.
   */
  async generateWarmPrompt(botId: string, userId: number): Promise<string | null> {
    logger.debug({ botId, userId }, 'AgentService.generateWarmPrompt: start');

    const row = await this.conversationService.load(botId, userId);
    if (!row.messages || row.messages.length === 0) {
      logger.debug({ botId, userId }, 'AgentService.generateWarmPrompt: no history, skipping');
      return null;
    }

    const model = this.modelFactory.create(
      env.DEFAULT_SUMMARIZATION_PROVIDER,
      env.DEFAULT_SUMMARIZATION_MODEL,
    );

    const historyMessages = toBaseMessages(row.messages);

    // Providers require user-first turn ordering — drop any leading assistant messages
    const firstUserIdx = historyMessages.findIndex(m => m.getType() === 'human');
    const trimmedHistory = firstUserIdx >= 0 ? historyMessages.slice(firstUserIdx) : historyMessages;

    try {
      const result = await model.invoke([
        new SystemMessage(
          "You are a persona analyst. Based on the onboarding conversation, write 3-5 sentences describing this user's personality, interests, communication style, and what they want from their AI assistant. Be specific and personal. Output only the description.",
        ),
        ...trimmedHistory,
        new HumanMessage(
          "Based on the conversation above, describe this user's persona in 3-5 sentences for their personal AI assistant. Be specific and personal.",
        ),
      ]) as AIMessage;

      const MAX_WARM_PROMPT_LENGTH = 2000;
      const warmPrompt = (
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      ).slice(0, MAX_WARM_PROMPT_LENGTH);

      logger.info(
        { botId, userId, promptLength: warmPrompt.length },
        'AgentService.generateWarmPrompt: done',
      );
      return warmPrompt;
    } catch (err) {
      logger.error({ err, botId, userId }, 'AgentService.generateWarmPrompt: failed');
      return null;
    }
  }

  /**
   * Seed a system prompt into a conversation row directly.
   * Used for warm prompt injection during child bot activation.
   */
  async seedSystemPrompt(botId: string, userId: number, systemPrompt: string): Promise<void> {
    logger.debug({ botId, userId }, 'AgentService.seedSystemPrompt');
    await setConversationSystemPrompt(botId, userId, systemPrompt);
  }
}
