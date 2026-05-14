# AGENTS.md — Quick Reference

## Commands

```
pnpm dev:cli          # start API server (hot reload, tsx watch)
pnpm dev:worker       # start worker process (hot reload, tsx watch)
pnpm start            # start API server (compiled, production)
pnpm worker           # start worker process (compiled, production)
pnpm build            # compile TypeScript → dist/
pnpm test             # run full test suite (Mocha)
pnpm test:watch       # run tests in watch mode
pnpm db:migrate       # run database migrations
pnpm set-webhook      # register Telegram webhooks
pnpm verify-manager   # verify manager bot capability
```

## Tech Stack

- **Runtime:** Node.js 22 LTS, pnpm@10.11.0, ESM (`"type": "module"`), TypeScript strict
- **Web:** Express 5
- **Queue:** BullMQ 5 + ioredis (Redis)
- **AI:** LangGraph, LangChain (OpenAI, Anthropic, DeepSeek, OpenRouter)
- **DB:** PostgreSQL 16 (raw `pg`, no ORM)
- **Config:** Zod schema validation (`src/config/env.ts`)
- **Logging:** pino
- **Testing:** Mocha 11 + Sinon 19 + Chai 5 + esmock 2

## Testing Conventions

- Mock external modules with `esmock` — always use `.js` extension in mock paths
- Redis/queue deps injected as optional third parameter for unit testability
- `sinon.restore()` and `esmock.purge()` in `afterEach`
- Do not start server or worker in tests

## Project Structure

```
src/
  bootstrap/
    AppBootstrap.ts       # Express server + bot registry setup; enqueues jobs; NO workers
    WorkerBootstrap.ts    # Standalone worker process; NO HTTP server
  cli/
    index.ts              # CLI entry: `start` (API) and `worker` commands
  config/
    env.ts                # Zod schema; single source of truth for all env vars
  db/
    client.ts             # pg Pool singleton
    migrate.ts            # migration runner
    queries/              # raw SQL query functions (no ORM)
  middleware/             # Express middleware (auth, rate-limiter, webhook-secret, error-handler)
  queues/
    types.ts              # ManagerMessageJobData, ChildMessageJobData
    manager-queue.ts      # BullMQ Queue 'manager-messages'
    child-queue.ts        # BullMQ Queue 'child-messages'
  routes/                 # Express routers (auth, webhook, bot-status, health)
  services/
    agent.ts              # AgentService: chatStream(), chat(), clearContext(), switchProvider()
    bot-registry.ts       # BotRegistry: registers bots, wires polling/webhook transports
    child-bot.ts          # enqueueChildMessage(), processChildBotMessage(), createChildBotHandler()
    conversation.ts       # ConversationService: load/save/clear per (botId, userId)
    conversation-lock.ts  # acquireLock(), releaseLock() — Redis NX/EX
    conversation-throttle.ts  # checkThrottle(conversationId, windowMs) — Redis SET NX PX
    encryption.ts         # AES-256-GCM + HKDF-SHA256 token encryption at rest
    managed-bot.ts        # ManagedBotService: handles ManagedBotUpdated, provisions child bots
    manager-bot.ts        # enqueueManagerMessage(), processManagerMessage()
    redis.ts              # getRedisClient() singleton (lazyConnect: true)
    session.ts            # JWT issue/verify (ES256 asymmetric)
    summarization.ts      # SummarizationService (dead code — not instantiated; graph uses summarizeNode in agent.ts)
    telegram-api.ts       # TelegramClient interface + HttpTelegramClient
    telegram-auth.ts      # Telegram Login Widget hash verification
    token-store.ts        # getDecryptedBotToken() — fetches + decrypts child bot token from DB
    llm/
      factory.ts          # LlmProviderFactory: resolves provider+model at runtime; model instance cache
      model-registry.ts   # MODEL_REGISTRY: model → maxTokens map; FALLBACK_CONFIG: { maxTokens: 4096 }
      provider.ts         # LlmProvider interface
      token-estimator.ts  # chars÷4 heuristic token estimator
      openai.ts           # OpenAI provider
      anthropic.ts        # Anthropic provider
  types/                  # Shared TypeScript interfaces (telegram, conversation, api)
  utils/
    errors.ts
    interpolate.ts        # {placeholder} template interpolation
    logger.ts             # pino logger + fatalExit()
    split-message.ts      # splitAtSentenceBoundary(), trimToLastSentence()
    telegram-html.ts      # toTelegramHtml() — kept but unused
    telegram-markdownv2.ts # toTelegramMarkdownV2() — CommonMark → Telegram MarkdownV2
  workers/
    message-worker.ts     # createMessageWorkers(deps) factory → { managerWorker, childWorker, close }
```

## Key Constraints

- No FK constraints in DB; UUID primary keys
- No ORM — raw `pg` queries only
- ESM throughout — all imports use `.js` extension even for `.ts` source files
- Never start the server or worker without explicit user instruction
- Stay in plan mode unless user says "yes" or "go"
- Migration convention: `migrations/001_init.sql` (consolidated), then additive `002_`, `003_` etc.
- `summarization.ts` is dead code — the AI graph uses `summarizeNode` inside `agent.ts`

## Env Vars Quick Reference

| Group | Key examples | Source |
|---|---|---|
| Telegram | `BOT_TOKEN`, `WEBHOOK_SECRET`, `CHILD_WEBHOOK_SECRET` | `src/config/env.ts` |
| Database | `DATABASE_URL` | `src/config/env.ts` |
| Encryption | `ENCRYPTION_MASTER_KEY`, `ENCRYPTION_KEY_VERSION` | `src/config/env.ts` |
| JWT | `ES256_PRIVATE_KEY`, `ES256_PUBLIC_KEY`, `JWT_VERSION` | `src/config/env.ts` |
| LLM | `OPENAI_API_KEY`, `DEFAULT_LLM_PROVIDER`, `DEFAULT_LLM_MODEL`, `FALLBACK_LLM_PROVIDER` | `src/config/env.ts` |
| Redis | `REDIS_URL`, `MANAGER_THROTTLE_MS`, `LOCK_TTL_SECS` | `src/config/env.ts` |
| Worker | `WORKER_CONCURRENCY`, `JOB_RETENTION_HOURS` | `src/config/env.ts` |
| Streaming | `STREAM_THROTTLE_MS` | `src/config/env.ts` |
| Server | `HOST`, `PORT`, `BASE_URL`, `LOG_LEVEL` | `src/config/env.ts` |
