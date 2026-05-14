import type { Pool } from 'pg';
import { pool as defaultPool } from '../client.js';
import { logger } from '../../utils/logger.js';
import type { ConversationMessage } from '../../types/conversation.js';

export type { ConversationMessage };

export interface ConversationRow {
  id: string;
  bot_id: string;
  /** pg BIGINT (OID 20) — parsed to number by the global type parser in db/client.ts */
  telegram_user_id: number;
  llm_provider: string;
  llm_model: string;
  summarization_provider: string;
  summarization_model: string;
  /** Parsed from JSONB by pg's built-in JSONB decoder */
  messages: ConversationMessage[];
  summary: string | null;
  system_prompt: string | null;
  force_summarize: boolean;
  created_at: Date;
  updated_at: Date;
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * pg's JSONB decoder already returns a parsed JS value for JSONB columns,
 * so `messages` arrives as an array — no manual JSON.parse needed on reads.
 * On writes we must JSON.stringify and cast with ::jsonb so pg treats the
 * text parameter as JSONB rather than TEXT.
 */
function serializeMessages(messages: ConversationMessage[]): string {
  return JSON.stringify(messages);
}

// ── queries ────────────────────────────────────────────────────────────────

export async function getConversation(
  botId: string,
  telegramUserId: number,
  pool: Pool = defaultPool,
): Promise<ConversationRow | null> {
  logger.debug({ botId, telegramUserId }, 'getConversation');
  const result = await pool.query<ConversationRow>(
    'SELECT * FROM conversations WHERE bot_id = $1 AND telegram_user_id = $2',
    [botId, telegramUserId],
  );
  const row = result.rows[0] ?? null;
  if (!row) {
    logger.debug({ botId, telegramUserId }, 'getConversation: not found');
  }
  return row;
}

export async function upsertConversation(
  botId: string,
  telegramUserId: number,
  // Only written on INSERT — not used for LLM selection; selection is driven by llmConfig
  initialMetadata: {
    llmProvider: string;
    llmModel: string;
    summarizationProvider: string;
    summarizationModel: string;
  },
  pool: Pool = defaultPool,
): Promise<ConversationRow> {
  logger.debug({ botId, telegramUserId }, 'upsertConversation');

  // ON CONFLICT DO UPDATE SET updated_at = updated_at is a no-op update (touches no
  // user-visible values) but satisfies PostgreSQL's RETURNING * requirement — unlike
  // DO NOTHING which returns 0 rows on conflict. Single round-trip for both new and
  // existing rows.
  const result = await pool.query<ConversationRow>(
    `INSERT INTO conversations
       (bot_id, telegram_user_id, llm_provider, llm_model, summarization_provider, summarization_model)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (bot_id, telegram_user_id) DO UPDATE SET updated_at = conversations.updated_at
     RETURNING *`,
    [
      botId,
      telegramUserId,
      initialMetadata.llmProvider,
      initialMetadata.llmModel,
      initialMetadata.summarizationProvider,
      initialMetadata.summarizationModel,
    ],
  );

  if (!result.rows[0]) throw new Error(`upsertConversation: unexpected empty result for botId=${botId}`);
  logger.debug({ botId, telegramUserId, id: result.rows[0].id }, 'upsertConversation: upserted');
  return result.rows[0] as ConversationRow;
}

export async function updateConversationMessages(
  botId: string,
  telegramUserId: number,
  messages: ConversationMessage[],
  summary: string | null,
  lastUsed?: {
    provider: string;
    model: string;
    summarizationProvider: string;
    summarizationModel: string;
  },
  pool: Pool = defaultPool,
): Promise<void> {
  logger.debug({ botId, telegramUserId }, 'updateConversationMessages');
  if (lastUsed) {
    await pool.query(
      `UPDATE conversations
       SET messages = $1::jsonb, summary = $2,
           llm_provider = $3, llm_model = $4,
           summarization_provider = $5, summarization_model = $6,
           updated_at = now()
       WHERE bot_id = $7 AND telegram_user_id = $8`,
      [
        serializeMessages(messages), summary,
        lastUsed.provider, lastUsed.model,
        lastUsed.summarizationProvider, lastUsed.summarizationModel,
        botId, telegramUserId,
      ],
    );
  } else {
    await pool.query(
      `UPDATE conversations
       SET messages = $1::jsonb, summary = $2, updated_at = now()
       WHERE bot_id = $3 AND telegram_user_id = $4`,
      [serializeMessages(messages), summary, botId, telegramUserId],
    );
  }
}

export async function clearConversation(
  botId: string,
  telegramUserId: number,
  pool: Pool = defaultPool,
): Promise<void> {
  logger.debug({ botId, telegramUserId }, 'clearConversation');
  await pool.query(
    `UPDATE conversations
     SET messages = '[]'::jsonb, summary = NULL, updated_at = now()
     WHERE bot_id = $1 AND telegram_user_id = $2`,
    [botId, telegramUserId],
  );
}

export async function setConversationSystemPrompt(
  botId: string,
  telegramUserId: number,
  systemPrompt: string,
  pool: Pool = defaultPool,
): Promise<void> {
  logger.debug({ botId, telegramUserId }, 'setConversationSystemPrompt');
  await pool.query(
    `UPDATE conversations
     SET system_prompt = $1, updated_at = now()
     WHERE bot_id = $2 AND telegram_user_id = $3`,
    [systemPrompt, botId, telegramUserId],
  );
}

export async function resetForceSummarize(
  botId: string,
  telegramUserId: number,
  pool: Pool = defaultPool,
): Promise<void> {
  logger.debug({ botId, telegramUserId }, 'resetForceSummarize');
  await pool.query(
    `UPDATE conversations
     SET force_summarize = FALSE, updated_at = now()
     WHERE bot_id = $1 AND telegram_user_id = $2`,
    [botId, telegramUserId],
  );
}

export async function updateToolsetState(
  botId: string,
  telegramUserId: number,
  patch: Record<string, unknown>,
  pool: Pool = defaultPool,
): Promise<number> {
  logger.debug({ botId, telegramUserId }, 'updateToolsetState');
  const result = await pool.query(
    `UPDATE conversations
     SET toolset_state = toolset_state || $1::jsonb, updated_at = NOW()
     WHERE bot_id = $2 AND telegram_user_id = $3`,
    [JSON.stringify(patch), botId, telegramUserId],
  );
  return result.rowCount ?? 0;
}

export async function getToolsetState(
  botId: string,
  telegramUserId: number,
  pool: Pool = defaultPool,
): Promise<Record<string, unknown>> {
  logger.debug({ botId, telegramUserId }, 'getToolsetState');
  const result = await pool.query<{ toolset_state: Record<string, unknown> }>(
    'SELECT toolset_state FROM conversations WHERE bot_id = $1 AND telegram_user_id = $2',
    [botId, telegramUserId],
  );
  return result.rows[0]?.toolset_state ?? {};
}
