# Message Queue Architecture

**Status:** Approved — pending implementation  
**Date:** 2026-05-14  
**Branch:** `feat/cli-bootstrap`

---

## Goal

Decouple Telegram webhook ingestion from LLM processing. The webhook handler returns 200 to Telegram in ~2ms; a separate worker process performs the LLM call, streaming, and Telegram reply.

---

## Decisions

| # | Decision |
|---|---|
| 1 | **Two-key Redis gate** — throttle key (`throttle:{conversationId}`) + processing lock (`lock:{conversationId}`); throttle leverages the lock |
| 2 | **Two BullMQ queues** — `manager-messages` and `child-messages` (separate, not a shared queue) |
| 3 | **Log and drop** — after max retries, log error, no user-facing message |
| 4 | **Standalone worker process** — `node dist/cli/index.js worker`; separate ECS task definition from the API process |

---

## Process Topology

```
┌─────────────────────────┐     ┌─────────────────────────────┐
│  ECS Task: "api"        │     │  ECS Task: "worker"         │
│                         │     │                              │
│  Express HTTP server    │     │  BullMQ Worker (manager)    │
│  Webhook handlers       │     │  BullMQ Worker (child)      │
│  Enqueues jobs only     │     │  No HTTP server             │
│                         │     │                              │
│  node dist/cli start    │     │  node dist/cli worker       │
└─────────────────────────┘     └─────────────────────────────┘
            │                               │
            └──────── Redis (BullMQ) ───────┘
```

Both tasks use the **same Docker image**, different `command` in ECS task definition.  
Scale independently: e.g. 2 API tasks + 5 worker tasks during spikes.

---

## Enqueue Gate

### Manager bot (throttle + lock)

```
Telegram message arrives
       │
       ▼
GET throttle:{conversationId}
  ├─ key exists → PTTL → reply "Please wait N seconds" → return 200
  └─ not set
       │
       ▼
SET lock:{conversationId} 1 NX EX {LOCK_TTL_SECS}
  ├─ null (lock held) → reply "I'm still working on your previous message" → return 200
  └─ OK (lock acquired)
       │
       ▼
SET throttle:{conversationId} 1 PX {MANAGER_THROTTLE_MS} NX
       │
       ▼
Enqueue job to "manager-messages" → return 200
```

### Child bot (lock only, no throttle)

```
Telegram message arrives
       │
       ├─ /start, /help, /clear, /provider → handle synchronously (no queue)
       │
       └─ AI chat message
              │
              ▼
       SET lock:{conversationId} 1 NX EX {LOCK_TTL_SECS}
         ├─ null → reply "I'm still working on your previous message" → return 200
         └─ OK
                │
                ▼
         Enqueue job to "child-messages" → return 200
```

### Worker (both bots)

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

---

## Redis Keys

| Key | Format | Set by | Released by | Expires |
|---|---|---|---|---|
| Throttle | `throttle:manager:{userId}` | Enqueue handler | TTL auto-expiry | `MANAGER_THROTTLE_MS` ms |
| Manager lock | `lock:manager:{userId}` | Enqueue handler | Worker `finally` | `LOCK_TTL_SECS` sec (safety TTL) |
| Child lock | `lock:child:{botId}:{userId}` | Enqueue handler | Worker `finally` | `LOCK_TTL_SECS` sec (safety TTL) |

**Conversation ID format:**
- Manager: `manager:{userId}`
- Child: `child:{botId}:{userId}`

---

## Job Data

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

**Job IDs (deduplication):**
- Manager: `` `msg:${messageId}` ``
- Child: `` `msg:${botId}:${messageId}` ``

BullMQ drops duplicate job IDs — protects against Telegram webhook retries.

---

## File Map

### New files

| File | Purpose |
|---|---|
| `src/queues/types.ts` | `ManagerMessageJobData`, `ChildMessageJobData` types |
| `src/queues/manager-queue.ts` | `Queue<ManagerMessageJobData>('manager-messages')` singleton |
| `src/queues/child-queue.ts` | `Queue<ChildMessageJobData>('child-messages')` singleton |
| `src/workers/message-worker.ts` | `createMessageWorkers(deps)` factory → `{ managerWorker, childWorker, close }` |
| `src/services/conversation-lock.ts` | `acquireLock(conversationId, ttlSecs)`, `releaseLock(conversationId)` |
| `src/bootstrap/WorkerBootstrap.ts` | Worker-process entry point — starts workers, no Express |

### Modified files

| File | Change |
|---|---|
| `src/services/conversation-throttle.ts` | Rename `checkManagerThrottle` → `checkThrottle(conversationId, windowMs)`; `windowMs=0` is noop |
| `src/services/manager-bot.ts` | Split: `enqueueManagerMessage()` (gate + enqueue) + `processManagerMessage()` (LLM logic) |
| `src/services/child-bot.ts` | Split: commands stay sync; AI chat → `enqueueChildMessage()`; `processChildBotMessage()` holds LLM logic |
| `src/bootstrap/AppBootstrap.ts` | Wire handlers to enqueue functions; does NOT start workers |
| `src/config/env.ts` | Add `WORKER_CONCURRENCY` (default `4`), `JOB_RETENTION_HOURS` (default `24`), `LOCK_TTL_SECS` (default `60`) |
| `src/cli/index.ts` | Add `worker` command → `WorkerBootstrap.start()` |
| `.env.example` | Document new vars |

---

## Environment Variables

| Var | Default | Purpose |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Already added |
| `MANAGER_THROTTLE_MS` | `5000` | Already added |
| `WORKER_CONCURRENCY` | `4` | Parallel jobs per worker instance |
| `JOB_RETENTION_HOURS` | `24` | Completed/failed job retention in Redis |
| `LOCK_TTL_SECS` | `60` | Safety TTL on lock key; auto-expires if worker crashes |

---

## ECS Deployment (future)

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

---

## Known Limitations / Future Work

- **Commands while AI in-flight**: `/clear` sent during an active LLM job executes immediately and resets context; the in-flight job continues with stale context. Acceptable for now.
- **Child bot throttle**: Child bot has no throttle today (lock-only gate). A `CHILD_THROTTLE_MS` env var can be added later.
- **Dead letter queue**: Failed jobs are logged and dropped. A future DLQ + alerting pass can be added.
- **Tool calls**: Worker architecture is designed to accommodate LangGraph tool call nodes in a future stage — no structural change needed.
- **BullMQ dashboard**: Bull Board or similar can be mounted on a `/admin/queues` route behind auth in a future pass.
