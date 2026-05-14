# Architecture

Single source of truth for system design, queue architecture, AI stack, database schema, auth model, and design decisions.

---

## 1. System Overview

The connector is a **two-process, two-bot** system.

- **Manager bot** — one per platform deployment. Handles Telegram Login Widget auth, user onboarding, and managed bot provisioning. Runs as a conversational AI in onboarding mode (before the user has a child bot) and as a settings/billing assistant once their child bot is live.
- **Child bots** — one per user. Each is a personal AI agent provisioned dynamically via the Telegram Managed Bots API (Bot API 9.6). Fully independent: separate token, separate webhook, separate conversation context.

**Process split:**
- **API process** — Express HTTP server. Receives Telegram webhooks, verifies auth, enqueues jobs to Redis. Returns `200 OK` to Telegram in ~2 ms. No LLM calls.
- **Worker process** — BullMQ workers. Dequeues jobs, performs LLM calls, streams replies to Telegram. No HTTP server.

Both processes run from the **same Docker image** with different CLI commands. Scale them independently.

---

## 2. Process Topology

```
┌─────────────────────────┐     ┌─────────────────────────────┐
│  Process: "api"         │     │  Process: "worker"          │
│                         │     │                              │
│  Express HTTP server    │     │  BullMQ Worker (manager)    │
│  Webhook ingestion      │     │  BullMQ Worker (child)      │
│  Enqueues jobs ~2ms     │     │  LLM calls + Telegram reply │
│                         │     │  No HTTP server             │
│  pnpm start             │     │  pnpm worker                │
└─────────────────────────┘     └─────────────────────────────┘
            │                               │
            └──────── Redis (BullMQ) ───────┘
                           │
                    PostgreSQL (shared)
```

Both processes share the same RDS (PostgreSQL) and ElastiCache (Redis) instances. Same Docker image, different `command` in the ECS task definition. Scale independently: e.g. 2 API tasks + 5 worker tasks during spikes.

---

## 3. Message Queue Architecture

### Goal

Decouple Telegram webhook ingestion from LLM processing. The webhook handler returns `200` to Telegram in ~2 ms; a separate worker process performs the LLM call, streaming, and Telegram reply.

### Decisions

| # | Decision |
|---|---|
| 1 | **Two-key Redis gate** — throttle key + processing lock; checked atomically at enqueue time |
| 2 | **Two BullMQ queues** — `manager-messages` and `child-messages` (separate, not shared) |
| 3 | **Log and drop** — after max retries, log error; no user-facing message |
| 4 | **Standalone worker process** — `node dist/cli/index.js worker`; separate ECS task definition |

### Enqueue Gate

#### Manager bot (throttle + lock)

```
Telegram message arrives
       │
       ▼
GET throttle:manager:{userId}
  ├─ key exists → PTTL → reply "Please wait N seconds" → return 200
  └─ not set
       │
       ▼
SET lock:manager:{userId} 1 NX EX {LOCK_TTL_SECS}
  ├─ null (lock held) → reply "I'm still working on your previous message" → return 200
  └─ OK (lock acquired)
       │
       ▼
SET throttle:manager:{userId} 1 PX {MANAGER_THROTTLE_MS} NX
       │
       ▼
Enqueue job to "manager-messages" → return 200
```

#### Child bot (lock only, no throttle)

```
Telegram message arrives
       │
       ├─ /start, /help, /clear, /provider → handle synchronously (no queue)
       │
       └─ AI chat message
              │
              ▼
       SET lock:child:{botId}:{userId} 1 NX EX {LOCK_TTL_SECS}
         ├─ null → reply "I'm still working on your previous message" → return 200
         └─ OK
                │
                ▼
         Enqueue job to "child-messages" → return 200
```

#### Worker (both bots)

```
Dequeue job
    │
    ▼
processManagerMessage() / processChildBotMessage()
    ├─ DB lookup
    ├─ LLM stream → Telegram reply
    └─ finally: DEL lock:{conversationId}

On failure (max retries reached):
    └─ logger.error(...) — log and drop; no user message
```

### Redis Keys

| Key pattern | Type | Set by | Expires / Released by | Purpose |
|---|---|---|---|---|
| `throttle:manager:{userId}` | string | `enqueueManagerMessage` | `MANAGER_THROTTLE_MS` PX TTL | Per-user message rate limit |
| `lock:manager:{userId}` | string | `enqueueManagerMessage` | Worker `finally` DEL; `LOCK_TTL_SECS` EX safety TTL | Prevent concurrent processing |
| `lock:child:{botId}:{userId}` | string | `enqueueChildMessage` | Worker `finally` DEL; `LOCK_TTL_SECS` EX safety TTL | Prevent concurrent processing |
| BullMQ internal keys | various | BullMQ | BullMQ managed | Queue state, job data, worker heartbeats |

**Conversation ID format:**
- Manager: `manager:{userId}`
- Child: `child:{botId}:{userId}`

### Job Data Types

```ts
// Manager
interface ManagerMessageJobData {
  conversationId: string;   // 'manager:{userId}'
  userId: number;
  chatId: number;
  messageId: number;        // used as jobId for deduplication
  text: string;
  firstName: string;        // raw — sanitized inside processManagerMessage
  username?: string;
}

// Child
interface ChildMessageJobData {
  conversationId: string;   // 'child:{botId}:{userId}'
  botId: string;
  userId: number;
  chatId: number;
  messageId: number;
  text: string;
  // NOTE: botToken is NOT stored in job data; worker fetches from DB by botId
}
```

### BullMQ Job IDs

- Manager: `msg-{messageId}`
- Child: `msg-{botId}-{messageId}`

**Why `-` not `:`:** BullMQ v5 uses `:` internally as a Redis key separator and forbids `:` in custom job IDs. The separator is `-`.

BullMQ deduplicates on job ID — protects against Telegram webhook retries delivering the same `message_id` twice.

### ECS Deployment

```
Task Definition: hellominds-api
  image: hellominds-connector:latest
  command: ["node", "dist/cli/index.js", "start"]
  count: 2

Task Definition: hellominds-worker
  image: hellominds-connector:latest
  command: ["node", "dist/cli/index.js", "worker"]
  count: 2–5 (scale independently)
```

Both share the same RDS (Postgres) and ElastiCache (Redis).

### Known Limitations / Future Work

- **Commands while AI in-flight:** `/clear` sent during an active LLM job executes immediately and resets context; the in-flight job continues with stale context. Acceptable for now.
- **Child bot throttle:** Child bot has no throttle today (lock-only gate). A `CHILD_THROTTLE_MS` env var can be added later.
- **Dead letter queue:** Failed jobs are logged and dropped. A future DLQ + alerting pass can be added.
- **Tool calls:** Worker architecture is designed to accommodate LangGraph tool call nodes in a future stage — no structural change needed.
- **BullMQ dashboard:** Bull Board or similar can be mounted on a `/admin/queues` route behind auth in a future pass.

---

## 4. AI Agent Stack

The AI stack is five layers that collaborate to produce a reply for every incoming Telegram message.

### Layer 1 — LLM Provider (`src/services/llm/`)

Abstracts provider-specific APIs behind a single interface.

- **`LlmProvider` interface:** `complete(messages, options) → string` — the only method any consumer calls
- **Providers:** `OpenAiProvider`, `AnthropicProvider`; DeepSeek and OpenRouter also supported via env config
- **`LlmProviderFactory`:** resolves a concrete `LlmProvider` from a provider name + model string at runtime; maintains a model instance cache
- **`model-registry.ts`:** maps model names → `maxTokens`; `FALLBACK_CONFIG: { maxTokens: 4096 }` for unknown models
- **`token-estimator.ts`:** `chars ÷ 4` heuristic — fast, allocation-free

**Model registry:**

| Provider | Model | Max Tokens |
|---|---|---|
| OpenAI | `gpt-4o` | 128,000 |
| OpenAI | `gpt-4o-mini` | 128,000 |
| OpenAI | `gpt-4-turbo` | 128,000 |
| Anthropic | `claude-3-5-sonnet-20241022` | 200,000 |
| Anthropic | `claude-3-5-haiku-20241022` | 200,000 |
| Anthropic | `claude-3-opus-20240229` | 200,000 |
| Unknown | (fallback) | 4,096 |

### Layer 2 — Conversation Service (`src/services/conversation.ts`)

Manages persistent conversation state per `(bot_id, telegram_user_id)` pair in PostgreSQL.

- **`load()`** — fetches the conversation row: system prompt, summary, message history, provider/model config
- **`save()`** — writes updated messages and summary back after LLM responds
- **`clearMessages()`** — wipes `messages` and `summary`; preserves `system_prompt`
- **`resetForceSummarize()`** — clears the `force_summarize` flag after a forced summarization cycle

Assembles the full message array sent to the LLM in this order:

```
[system prompt] + [summary message] + [recent messages] + [new user message]
```

### Layer 3 — Agent Service (`src/services/agent.ts`) — LangGraph-based

Central orchestrator. Exposes the public API consumed by bot handlers.

| Method | Signature | Description |
|---|---|---|
| `chatStream` | `(botId, userId, message, systemPrompt) → AsyncGenerator<string>` | Main entry point used in production by both bots. Streams tokens as they arrive. |
| `chat` | `(botId, userId, message, systemPrompt) → string` | Collects the full reply; kept for tests. |
| `clearContext` | `(botId, userId) → void` | Wipes `messages` and `summary`; preserves `system_prompt`. |
| `switchProvider` | `(botId, userId, provider, model) → void` | Updates `llm_provider` and `llm_model` for the conversation row. |
| `generateWarmPrompt` | `(managerBotId, ownerTelegramId) → string` | Reads the user's onboarding conversation and distils it into a child bot system prompt. |

**LangGraph nodes (in execution order):**

```
loadHistoryNode → checkBudgetRouter → (optional) summarizeNode → saveNode
```

- **`checkBudgetRouter`:** budget = `maxTokens * 0.8`; if `force_summarize` flag is set in DB, bypasses token count check and routes to `summarizeNode` unconditionally
- **`summarizeNode`:** removes 75% of messages when `force_summarize=true` (aggressive), 50% for automatic (conservative); resets `force_summarize` flag on success
- **`force_summarize` DB toggle:** added via `migrations/002_force_summarize.sql`; set by an admin to force summarization on the next turn without waiting for the token budget

### Layer 4 — Streaming & Telegram UX

- **Draft bubble:** `sendMessageDraft(token, chatId, draftId, 'Thinking')` fires after a 250 ms `setTimeout` (fire-and-forget) — avoids a visible flash for fast LLM responses
- **Typing indicator:** `sendChatAction('typing')` sent on the first token; refreshed every 4 s during long streams
- **Stream drafts:** `sendMessageDraft` calls are throttled by `STREAM_THROTTLE_MS` (default `0` = send every token); all fire-and-forget, never block the token loop — errors swallowed with `.catch()`
- **Final reply:** `sendMessage` with `parse_mode: 'MarkdownV2'`; `splitAtSentenceBoundary()` guards against Telegram's 4096-char message limit
- **Format conversion:** `toTelegramMarkdownV2()` converts CommonMark LLM output → Telegram MarkdownV2 using a save-replace-restore algorithm that handles all 18 special chars Telegram requires escaped in plain text

### Layer 5 — Bot Handlers

**Manager bot** (`src/services/manager-bot.ts`):
- `enqueueManagerMessage()` — throttle + lock gate, then enqueue
- `processManagerMessage()` — DB lookup, LLM stream, Telegram reply

**Child bot** (`src/services/child-bot.ts`):
- `enqueueChildMessage()` — lock gate, then enqueue
- `processChildBotMessage()` — DB lookup, token fetch, LLM stream, Telegram reply
- `createChildBotHandler()` — wires commands and AI chat to the correct handlers

Commands (`/start`, `/help`, `/clear`, `/provider`) are handled **synchronously** in `createChildBotHandler()` — they never enter the queue, never touch the LLM wait path.

### LLM Failure Handling

```
chatStream() / chat()
    ↓
LlmProvider.complete()   ← primary
    ├─ success → yield tokens
    └─ error
           ↓
    FALLBACK_LLM_PROVIDER set?
      No  → surface error to caller
      Yes → LlmProviderFactory(fallback) → complete()
               ├─ success → yield tokens (logs: fallback used)
               └─ error → surface to caller
```

Summarization failures are **logged and skipped** — the conversation continues without compression. No fallback LLM call is made for summarization failures.

---

## 5. Bot Architecture

### Manager Bot — Two Modes

| User's bot status | Mode | System prompt focus |
|---|---|---|
| None / PENDING / PROVISIONING | Onboarding | Guide user to create their personal bot; share deep link |
| ACTIVE | Settings | Platform assistant for account/billing; defer general chat to child bot |

**Deep link format:**
```
https://t.me/newbot/{botUsername}/{suggestedUsername}?name={encodedName}
```

**Input sanitization before embedding in URLs:**
- `first_name`: stripped to `[a-zA-Z0-9 \-']`, max 50 chars
- `username`: validated against `[a-zA-Z0-9_]{5,32}` before use

### Child Bot — Personal AI Agent

Each child bot is a fully independent AI agent with its own persistent context, system prompt, and provider configuration.

**In-chat commands:**

| Command | Behaviour |
|---|---|
| `/start` | Greet the user and explain what the bot can do |
| `/help` | Show available commands |
| `/clear` | Wipe conversation history and summary. Preserves `system_prompt`. |
| `/provider <name> [model]` | Switch LLM provider/model for this conversation |

Allowed providers for `/provider`: `openai`, `anthropic`. Others blocked.

**Warm prompt:** LLM-generated from the user's onboarding conversation with the manager bot at provisioning time. Stored as `conversations.system_prompt`. Prepended to every LLM call. Never overwritten by normal operation. Survives `/clear`.

### Provisioning Lifecycle

```
PENDING → PROVISIONING → ACTIVE
```

`DEACTIVATED` — assigned to rows stuck in PENDING or PROVISIONING for > 5 minutes.

On startup, `deactivateStalePendingBots(5)` runs automatically to clean up stale rows.

---

## 6. Database Schema

Migrations live in `migrations/`. Convention: `001_init.sql` is the consolidated initial schema; subsequent changes are additive files `002_`, `003_`, etc.

**No foreign key constraints by design.** Tables are intentionally decoupled. UUID primary keys throughout.

### `users`

Telegram login users. Created/updated on every successful Login Widget verification.

### `managed_bots`

One row per user. Tracks the user's child bot.

| Column | Type | Notes |
|---|---|---|
| `bot_id` | UUID PK | Internal identifier |
| `owner_telegram_id` | BIGINT | Telegram user ID of the owner |
| `bot_token` | TEXT | AES-256-GCM encrypted; decrypt with `getDecryptedBotToken()` |
| `bot_username` | TEXT | Telegram username of the child bot |
| `status` | TEXT | `PENDING` / `PROVISIONING` / `ACTIVE` / `DEACTIVATED` |
| `polling_offset` | BIGINT | Used when running child bot in polling mode |

### `conversations`

One row per `(bot_id, telegram_user_id)` pair. Stores the full AI context.

```sql
bot_id                 TEXT NOT NULL
telegram_user_id       BIGINT NOT NULL
llm_provider           TEXT NOT NULL DEFAULT 'openai'
llm_model              TEXT NOT NULL DEFAULT 'gpt-4o'
summarization_provider TEXT NOT NULL DEFAULT 'openai'
summarization_model    TEXT NOT NULL DEFAULT 'gpt-4o-mini'
messages               JSONB NOT NULL DEFAULT '[]'
summary                TEXT
system_prompt          TEXT
force_summarize        BOOLEAN NOT NULL DEFAULT FALSE
UNIQUE (bot_id, telegram_user_id)
```

**Context window budget:** `floor(model.maxTokens * 0.8)` — 80% of the model's limit. When `force_summarize=true`, triggers summarization regardless of token count.

**Summarization fractions:**
- `force_summarize=true`: 75% of messages removed (aggressive)
- Automatic (token budget exceeded): 50% of messages removed (conservative)

---

## 7. Auth & Security

### Telegram Login Widget Verification

- **Algorithm:** HMAC-SHA256
- **Secret key derivation:** `SHA256(botToken)` — plain hash, **not** `HMAC(botToken)`
- **Data check string:** all fields except `hash`, sorted alphabetically, joined with `\n`
- **Replay prevention:** `auth_date` must be less than 5 minutes old

```js
const secretKey = crypto.createHash('sha256').update(botToken).digest();
const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
```

### JWT (ES256 Asymmetric)

| Parameter | Value |
|---|---|
| Algorithm | ES256 (ECDSA P-256) |
| Access token TTL | Default 30 days (`JWT_EXPIRES_IN` seconds) |
| Refresh token TTL | Default 7 days (`JWT_REFRESH_EXPIRES_IN` seconds) |
| Global invalidation | Bump `JWT_VERSION` to invalidate all issued tokens simultaneously |
| Issuer | `hellominds-telegram-connector` |

Keys: `ES256_PRIVATE_KEY` and `ES256_PUBLIC_KEY` in env. Store as PEM strings.

### Token Encryption at Rest (AES-256-GCM + HKDF-SHA256)

Child bot tokens are encrypted before storage in `managed_bots.bot_token`.

| Parameter | Value |
|---|---|
| Cipher | AES-256-GCM |
| Key derivation | HKDF-SHA256 |
| HKDF salt | `hellominds-telegram-connector-v1` |
| Master key | `ENCRYPTION_MASTER_KEY` — 64 hex chars (32 bytes) |
| Key versioning | `ENCRYPTION_KEY_VERSION` (integer); each encrypted value stores the version alongside the ciphertext |

To rotate: increment `ENCRYPTION_KEY_VERSION` and re-encrypt existing rows. Old rows remain decryptable because the version is stored with the ciphertext.

---

## 8. Redis Key Reference

| Key pattern | Type | Set by | Expires / Released by | Purpose |
|---|---|---|---|---|
| `throttle:manager:{userId}` | string | `enqueueManagerMessage` | `MANAGER_THROTTLE_MS` PX TTL | Per-user message rate limit |
| `lock:manager:{userId}` | string | `enqueueManagerMessage` | Worker `finally` DEL; `LOCK_TTL_SECS` EX safety TTL | Prevent concurrent processing |
| `lock:child:{botId}:{userId}` | string | `enqueueChildMessage` | Worker `finally` DEL; `LOCK_TTL_SECS` EX safety TTL | Prevent concurrent processing |
| BullMQ internal keys | various | BullMQ | BullMQ managed | Queue state, job data, worker heartbeats |

**Lock acquisition pattern:** `SET key 1 PX {ms} NX` — single atomic operation; no Lua script needed.

---

## 9. Environment Variables

All variables are validated at startup by the Zod schema in `src/config/env.ts`. The process exits immediately on any validation failure.

### Telegram

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_TOKEN` | Yes | — | Manager bot API token |
| `BOT_USERNAME` | Yes | — | Manager bot username (leading `@` stripped automatically) |
| `WEBHOOK_SECRET` | Yes | — | Secret sent in `X-Telegram-Bot-Api-Secret-Token` header for manager webhook. Min 32 chars, `[A-Za-z0-9_-]` only. |
| `CHILD_WEBHOOK_SECRET` | Yes | — | Webhook secret for all child bot endpoints. Same constraints as `WEBHOOK_SECRET`. |

### Database

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string (`postgres://user:pass@host:5432/db`) |

### Encryption

| Variable | Required | Default | Description |
|---|---|---|---|
| `ENCRYPTION_MASTER_KEY` | Yes | — | 64 hex chars (32 bytes). Used to derive per-version AES-256-GCM keys via HKDF-SHA256. |
| `ENCRYPTION_KEY_VERSION` | No | `1` | Integer. Bump to rotate encryption key. Old ciphertexts remain decryptable. |

### JWT

| Variable | Required | Default | Description |
|---|---|---|---|
| `ES256_PRIVATE_KEY` | Yes | — | PEM-encoded ES256 private key for signing JWTs |
| `ES256_PUBLIC_KEY` | Yes | — | PEM-encoded ES256 public key for verifying JWTs |
| `JWT_EXPIRES_IN` | No | `2592000` | Access token TTL in seconds (default: 30 days) |
| `JWT_REFRESH_EXPIRES_IN` | No | `604800` | Refresh token TTL in seconds (default: 7 days) |
| `JWT_VERSION` | No | `1` | Integer. Bump to invalidate all currently issued tokens. |

### CORS

| Variable | Required | Default | Description |
|---|---|---|---|
| `CORS_ORIGINS` | No | — | Comma-separated list of allowed origins. Absent/empty = allow all in dev, deny all in prod. |

### Server

| Variable | Required | Default | Description |
|---|---|---|---|
| `HOST` | No | `0.0.0.0` | Bind address for the Express server |
| `PORT` | No | `3000` | Port for the Express server |
| `BASE_URL` | Yes | — | Public HTTPS URL of this service (used for webhook registration) |
| `LOG_LEVEL` | No | `info` | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` |
| `LOG_DIR` | No | `logs` | Directory for log files |

### Runtime

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |

### Update Mode

| Variable | Required | Default | Description |
|---|---|---|---|
| `MANAGER_UPDATE_MODE` | No | `auto` | How the manager bot receives updates: `polling`, `webhook`, or `auto`. `auto` resolves to `webhook` in production and `polling` in development. |

### LLM Providers

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | If using OpenAI | — | Required when `DEFAULT_LLM_PROVIDER`, `DEFAULT_SUMMARIZATION_PROVIDER`, or `FALLBACK_LLM_PROVIDER` is `openai` |
| `ANTHROPIC_API_KEY` | If using Anthropic | — | Required when any provider setting is `anthropic` |
| `DEEPSEEK_API_KEY` | If using DeepSeek | — | Required when any provider setting is `deepseek` |
| `OPENROUTER_API_KEY` | If using OpenRouter | — | Required when any provider setting is `openrouter` |
| `DEFAULT_LLM_PROVIDER` | No | `openai` | Default provider for new conversations. Values: `openai`, `anthropic`, `deepseek`, `openrouter` |
| `DEFAULT_LLM_MODEL` | No | `gpt-4o` | Default model for new conversations |
| `DEFAULT_SUMMARIZATION_PROVIDER` | No | `openai` | Provider used for context summarization |
| `DEFAULT_SUMMARIZATION_MODEL` | No | `gpt-4o-mini` | Model used for context summarization |
| `FALLBACK_LLM_PROVIDER` | No | — | Provider to use when the primary LLM call fails. Must be set together with `FALLBACK_LLM_MODEL`. |
| `FALLBACK_LLM_MODEL` | No | — | Model to use with the fallback provider. Must be set together with `FALLBACK_LLM_PROVIDER`. |

### Manager Bot Prompts

| Variable | Required | Default | Description |
|---|---|---|---|
| `MANAGER_ONBOARDING_PROMPT` | No | hardcoded | System prompt for manager bot in onboarding mode. Overrides the built-in default. |
| `MANAGER_SETTINGS_PROMPT` | No | hardcoded | System prompt for manager bot in settings/billing mode. Overrides the built-in default. |

### Streaming

| Variable | Required | Default | Description |
|---|---|---|---|
| `STREAM_THROTTLE_MS` | No | `0` | Minimum milliseconds between `sendMessageDraft` calls during streaming. `0` = no throttle (send every token). |

### Redis

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection URL |
| `MANAGER_THROTTLE_MS` | No | `5000` | Manager bot per-user rate limit window in milliseconds |
| `LOCK_TTL_SECS` | No | `60` | Safety TTL on conversation locks in seconds. Auto-expires if a worker crashes mid-job. |

### Worker

| Variable | Required | Default | Description |
|---|---|---|---|
| `WORKER_CONCURRENCY` | No | `4` | Number of jobs processed in parallel per worker instance |
| `JOB_RETENTION_HOURS` | No | `24` | How long completed and failed jobs are retained in Redis |

---

## 10. Key Design Decisions Log

1. **MarkdownV2 over HTML** — Telegram HTML has fewer formatting options; MarkdownV2 aligns with LLM CommonMark output.

2. **Draft bubble with 250 ms delay** — avoids a visible flash for fast LLM responses; implemented with `setTimeout` + fire-and-forget `sendMessageDraft`.

3. **Stream drafts fire-and-forget** — draft update calls never block the token loop; errors swallowed with `.catch()` to protect throughput.

4. **`force_summarize` DB toggle** — an admin can force summarization on the next turn without waiting for the token budget to trigger automatically. Useful for testing and manual context cleanup.

5. **75%/50% summarization fractions** — 75% of messages removed when forced (aggressive reset), 50% for automatic (conservative, preserves more recent context).

6. **Redis for per-conversation throttle** — chosen over a DB column because Redis TTL semantics are exact and `SET NX PX` is atomic. No polling or cleanup job required.

7. **`ioredis` over `node-redis`** — better TypeScript support; `lazyConnect: true` allows the client to be constructed without an immediate connection, making unit tests safe.

8. **`SET key 1 PX {ms} NX`** — single atomic Redis command for throttle; no Lua script needed, no TOCTOU race.

9. **Throttle + lock two-key gate** — throttle enforces a timing window (rate limit); lock enforces concurrency (at most one job per conversation). Both checked at enqueue time, not at worker start. Fail-open on Redis error to avoid dropping messages if Redis is briefly unavailable.

10. **Lock acquired at enqueue time** — prevents two simultaneous webhook deliveries from both enqueuing a job for the same conversation. Ensures the queue has at most one pending job per conversation at any time.

11. **BullMQ job ID separator `-` not `:`** — BullMQ v5 uses `:` internally as a Redis key separator and explicitly forbids `:` in custom job IDs. Job IDs are `msg-{messageId}` (manager) and `msg-{botId}-{messageId}` (child).

12. **Standalone worker process** — separate ECS task definition using the same Docker image with a different CLI command. Scales independently of the API process.

13. **Log and drop on max retries** — after BullMQ exhausts its retry budget, the error is logged and the job is dropped. No user-facing error message is sent. Keeps the system clean; a future DLQ pass can improve this.

14. **Commands bypass the queue** — `/start`, `/help`, `/clear`, `/provider` are instant and stateless (or do trivial DB writes). Handling them synchronously avoids queue latency and eliminates lock contention for non-LLM operations.

15. **Child bot token not in job data** — the bot token is a secret. Storing it in Redis (job data) would expand the secret attack surface. Workers fetch the token from the DB at processing time using `botId`.

16. **No FK constraints** — intentional. Tables are decoupled to allow independent writes and avoid cascading lock contention. UUIDs as PKs provide stable references without a centralised sequence.
