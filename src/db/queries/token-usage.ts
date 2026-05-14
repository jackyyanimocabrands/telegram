import type { Pool } from 'pg';

// ── parameter / result types ───────────────────────────────────────────────

export interface InsertTokenUsageParams {
  botId: string;
  telegramUserId: number;
  provider: string;
  model: string;
  usageType: 'chat' | 'summarization';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsageSummaryFilters {
  provider?: string;
  model?: string;
  from?: Date;
  to?: Date;
}

export interface TokenUsageSummaryRow {
  provider: string;
  model: string;
  usage_type: string;
  total_input_tokens: string;   // pg returns bigint as string
  total_output_tokens: string;
  sum_total_tokens: string;     // renamed from total_tokens
  call_count: string;
}

export interface TokenUsageRawFilters {
  from?: Date;
  to?: Date;
  limit?: number;  // default 1000
}

export interface TokenUsageRow {
  id: string;
  bot_id: string;
  telegram_user_id: string;
  provider: string;
  model: string;
  usage_type: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  created_at: Date;
}

// ── queries ────────────────────────────────────────────────────────────────

export async function insertTokenUsage(pool: Pool, params: InsertTokenUsageParams): Promise<void> {
  await pool.query(
    `INSERT INTO token_usage
       (bot_id, telegram_user_id, provider, model, usage_type,
        input_tokens, output_tokens, total_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.botId,
      params.telegramUserId,
      params.provider,
      params.model,
      params.usageType,
      params.inputTokens,
      params.outputTokens,
      params.totalTokens,
    ],
  );
}

export async function getTokenUsageSummary(
  pool: Pool,
  filters: TokenUsageSummaryFilters,
): Promise<TokenUsageSummaryRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.provider !== undefined) {
    params.push(filters.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (filters.model !== undefined) {
    params.push(filters.model);
    conditions.push(`model = $${params.length}`);
  }
  if (filters.from !== undefined) {
    params.push(filters.from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (filters.to !== undefined) {
    params.push(filters.to);
    conditions.push(`created_at <= $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await pool.query<TokenUsageSummaryRow>(
    `SELECT
       provider,
       model,
       usage_type,
       SUM(input_tokens)::TEXT  AS total_input_tokens,
       SUM(output_tokens)::TEXT AS total_output_tokens,
       SUM(total_tokens)::TEXT  AS sum_total_tokens,
       COUNT(*)::TEXT           AS call_count
     FROM token_usage
     ${where}
     GROUP BY provider, model, usage_type
     ORDER BY provider, model, usage_type`,
    params,
  );

  return result.rows;
}

export async function getConversationTokenUsage(
  pool: Pool,
  botId: string,
  telegramUserId: number,
  filters: TokenUsageRawFilters,
): Promise<TokenUsageRow[]> {
  const params: unknown[] = [botId, telegramUserId];
  const conditions: string[] = ['bot_id = $1', 'telegram_user_id = $2'];

  if (filters.from !== undefined) {
    params.push(filters.from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (filters.to !== undefined) {
    params.push(filters.to);
    conditions.push(`created_at <= $${params.length}`);
  }

  const limitVal = filters.limit ?? 1000;
  params.push(limitVal);

  const result = await pool.query<TokenUsageRow>(
    `SELECT * FROM token_usage
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows;
}

export async function getBotTokenUsage(
  pool: Pool,
  botId: string,
  filters: TokenUsageRawFilters,
): Promise<TokenUsageRow[]> {
  const params: unknown[] = [botId];
  const conditions: string[] = ['bot_id = $1'];

  if (filters.from !== undefined) {
    params.push(filters.from);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (filters.to !== undefined) {
    params.push(filters.to);
    conditions.push(`created_at <= $${params.length}`);
  }

  const limitVal = filters.limit ?? 1000;
  params.push(limitVal);

  const result = await pool.query<TokenUsageRow>(
    `SELECT * FROM token_usage
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows;
}

// end of file
