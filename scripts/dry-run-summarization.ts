/**
 * dry-run-summarization.ts
 *
 * CLI dry-run script for the conversation summarization pipeline.
 * Lets operators inspect summarisation behaviour without mutating the DB.
 *
 * Usage:
 *   pnpm tsx scripts/dry-run-summarization.ts <bot-id> <telegram-user-id> [--force] [--dry|--live]
 *
 * Flags:
 *   --dry   (default) Use a mock modelFactory — no real LLM call made.
 *   --live  Call the real LLM; still does NOT write back to DB.
 *   --force Treat run as if forceSummarize=true regardless of DB flag.
 */

import type { ConversationMessage } from '../src/types/conversation.js';
import type { ILlmModelFactory } from '../src/services/agent.js';
import { toBaseMessages } from '../src/services/conversation.js';
import { checkBudgetRouter, summarizeNode } from '../src/services/agent.js';
import { getModelConfig } from '../src/services/llm/model-registry.js';
import { llmConfig } from '../src/config/llm-config.js';
import { getConversation } from '../src/db/queries/conversations.js';
import { pool } from '../src/db/client.js';
import { LlmProviderFactory } from '../src/services/llm/factory.js';
import { estimateTokens } from '../src/services/llm/token-estimator.js';
import { AIMessage } from '@langchain/core/messages';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScriptDeps {
  loadConversation: (
    botId: string,
    userId: bigint,
  ) => Promise<{ messages: ConversationMessage[]; summary: string | null; forceSummarize: boolean }>;
  modelFactory: ILlmModelFactory;
  stdout: { write(s: string): void };
}

export interface ParsedArgs {
  botId: string;
  telegramUserId: string;
  mode: 'dry' | 'live';
  force: boolean;
}

// ── Arg parser ─────────────────────────────────────────────────────────────────

const USAGE = `Usage: pnpm tsx scripts/dry-run-summarization.ts <bot-id> <telegram-user-id> [--force] [--dry|--live]

Arguments:
  bot-id              Bot identifier (UUID, e.g. 550e8400-e29b-41d4-a716-446655440000)
  telegram-user-id    Telegram numeric user ID (positive integer)

Flags:
  --dry    (default) Use mock modelFactory — no LLM call
  --live   Call real LLM — no DB writes
  --force  Treat as forceSummarize=true regardless of DB flag

Errors:
  --dry and --live cannot be used together
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let hasDry = false;
  let hasLive = false;
  let force = false;

  for (const arg of argv) {
    if (arg === '--dry') {
      hasDry = true;
    } else if (arg === '--live') {
      hasLive = true;
    } else if (arg === '--force') {
      force = true;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    } else {
      throw new Error(`Unknown flag: ${arg}\n\n${USAGE}`);
    }
  }

  if (positional.length < 2) {
    throw new Error(`Missing required arguments: <bot-id> <telegram-user-id>\n\n${USAGE}`);
  }

  if (hasDry && hasLive) {
    throw new Error(`--dry and --live cannot be used together.\n\n${USAGE}`);
  }

  const [botId, telegramUserId] = positional as [string, string];

  if (!/^[0-9a-f-]{8,36}$/i.test(botId)) {
    throw new Error(`Invalid bot-id: expected a UUID\n\n${USAGE}`);
  }

  if (!/^\d+$/.test(telegramUserId)) {
    throw new Error(`Invalid telegram-user-id: must be a positive integer\n\n${USAGE}`);
  }

  return {
    botId,
    telegramUserId,
    mode: hasLive ? 'live' : 'dry',
    force,
  };
}

// ── Main run function ─────────────────────────────────────────────────────────

export async function run(args: ParsedArgs, deps: ScriptDeps): Promise<void> {
  const { botId, telegramUserId, mode, force } = args;
  const { stdout } = deps;

  const w = (s: string) => stdout.write(s);

  w(`=== Dry-Run Summarization ===\n`);
  w(`Bot ID:        ${botId}\n`);
  w(`Telegram User: ${telegramUserId}\n`);
  w(`Mode:          ${mode}\n`);
  w(`Force:         ${force ? 'yes' : 'no'}\n`);
  w(`\n`);

  // Load conversation from DB
  const userId = BigInt(telegramUserId);
  const conv = await deps.loadConversation(botId, userId);

  if (conv.messages.length === 0) {
    w(`No conversation found (no messages). Exiting.\n`);
    return;
  }

  // Convert DB messages → BaseMessage[]
  const baseMessages = toBaseMessages(conv.messages);

  // Build minimal AgentState for checkBudgetRouter
  const model = llmConfig.chat[0]!.model;
  const maxTokens = getModelConfig(model).maxTokens;
  const forceSummarize = force ? true : conv.forceSummarize;

  const state: {
    messages: typeof baseMessages;
    model: string;
    botId: string;
    userId: number;
    forceSummarize: boolean;
    userInput: string;
    summary: string;
    provider: string;
    summarizationProvider: string;
    summarizationModel: string;
    systemPromptOverride: undefined;
    chatUsage: null;
    summarizationUsage: null;
    summarizationRan: boolean;
    tools: never[];
    toolCallRound: number;
    toolsetState: Record<string, unknown>;
  } = {
    messages: baseMessages,
    forceSummarize,
    botId,
    userId: Number(userId),
    model,
    // Remaining AgentState fields with sensible defaults
    userInput: '',
    summary: conv.summary ?? '',
    provider: llmConfig.chat[0]!.provider,
    summarizationProvider: llmConfig.summarization[0]!.provider,
    summarizationModel: llmConfig.summarization[0]!.model,
    systemPromptOverride: undefined,
    chatUsage: null,
    summarizationUsage: null,
    summarizationRan: false,
    tools: [],
    toolCallRound: 0,
    toolsetState: {},
  };

  // Compute token budget info for display
  const budget = Math.floor(maxTokens * llmConfig.summarizationConfig.threshold);
  const tokenInput = baseMessages.map(m => {
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

  w(`--- Token Budget ---\n`);
  w(`Current tokens : ${currentTokens}\n`);
  w(`Budget         : ${budget}  (threshold=${llmConfig.summarizationConfig.threshold} × maxTokens=${maxTokens}, model=${model})\n`);

  const verdict = checkBudgetRouter(state);

  w(`Verdict        : ${verdict}\n`);
  w(`\n`);

  if (verdict === 'save') {
    w(`No summarization would fire. Exiting.\n`);
    return;
  }

  // Determine which messages summarizeNode would compress
  const historyMessages = baseMessages.filter(
    m => {
      const type = m.getType();
      return type !== 'system' && ['human', 'ai', 'tool'].includes(type);
    },
  );
  const fraction = forceSummarize
    ? llmConfig.summarizationConfig.forceCompression
    : llmConfig.summarizationConfig.compression;
  const oldestCount = Math.floor(historyMessages.length * fraction);
  const messagesToCompress = historyMessages.slice(0, oldestCount);

  w(`--- Messages to Compress (${messagesToCompress.length} of ${baseMessages.length} total) ---\n`);
  if (messagesToCompress.length === 0) {
    w(`(no messages eligible for compression)\n`);
  } else {
    messagesToCompress.forEach((m, idx) => {
      const type = m.getType();
      const role = type === 'human' ? 'human' : type === 'ai' ? 'ai' : type;
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const preview = content.slice(0, 80);
      w(`[${idx + 1}] ${role.padEnd(7)}: "${preview}"  (${content.length} chars)\n`);
    });
  }
  w(`\n`);

  // Choose modelFactory: dry = mock, live = real (deps.modelFactory only accessed here in live mode)
  let activeFactory: ILlmModelFactory;
  if (mode === 'dry') {
    activeFactory = {
      create: (_provider: string, _model: string) => ({
        invoke: async () => new AIMessage('[DRY RUN — no LLM call made]'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stream: async function* () {} as any,
      }),
    };
  } else {
    activeFactory = deps.modelFactory;
  }

  // Run summarizeNode (read-only — never persists)
  const result = await summarizeNode(state, { modelFactory: activeFactory });

  w(`--- Summary Output ---\n`);
  w(`${result.summary ?? '(no summary produced)'}\n`);
  w(`\n`);
  w(`No DB writes performed.\n`);
}

// ── Top-level entry-point gated behind direct execution check ─────────────────

if (
  process.argv[1]?.endsWith('dry-run-summarization.ts') ||
  process.argv[1]?.endsWith('dry-run-summarization.js')
) {
  const parsedArgs = parseArgs(process.argv.slice(2));

  // LlmProviderFactory is only instantiated when mode === 'live'.
  // In dry mode deps.modelFactory is never accessed by run() — the lazy getter
  // ensures no credentials are loaded and no error stack traces leak during dry runs.
  let _factoryInstance: LlmProviderFactory | undefined;

  const realDeps: ScriptDeps = {
    loadConversation: async (botId: string, userId: bigint) => {
      const row = await getConversation(botId, Number(userId), pool);
      if (!row) {
        return { messages: [], summary: null, forceSummarize: false };
      }
      return {
        messages: row.messages,
        summary: row.summary,
        forceSummarize: row.force_summarize,
      };
    },
    get modelFactory(): ILlmModelFactory {
      // Deferred construction — only reached when mode === 'live'
      // (run() only accesses deps.modelFactory inside the live-mode `else` branch).
      if (!_factoryInstance) {
        _factoryInstance = new LlmProviderFactory();
      }
      return _factoryInstance;
    },
    stdout: process.stdout,
  };

  run(parsedArgs, realDeps).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  });
}
