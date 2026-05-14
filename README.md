# HelloMinds Telegram Connector

A service that authenticates users via Telegram Login Widget and provisions a dedicated managed Telegram bot per user. Each user's bot runs a LangGraph-based AI agent with per-user context management, persistent conversation history, and configurable LLM providers.

---

## Prerequisites

| Requirement | Details |
|---|---|
| Node.js | ≥ 22.0.0 |
| pnpm | ≥ 10.0.0 |
| PostgreSQL | 16 |
| Redis | 7 |
| Telegram Manager Bot | Must have `can_manage_bots: true` |

---

## Quick Start

```bash
cp .env.example .env    # fill in required values
pnpm install
pnpm db:migrate

# Terminal 1 — API server
pnpm dev:cli

# Terminal 2 — Worker process
pnpm dev:worker
```

---

## Environment Setup

Copy `.env.example` to `.env` and fill in the required values. Every variable is documented in `.env.example` with a description and its default. For the full reference including validation rules and inter-variable constraints, see [Architecture.md](./Architecture.md#9-environment-variables).

---

## Documentation

- [`Architecture.md`](./Architecture.md) — full system design, queue architecture, AI stack, database schema, auth, all design decisions
- [`AGENTS.md`](./AGENTS.md) — build/test/run commands, project structure, coding conventions
- [`docs/telegram-managed-bots.md`](./docs/telegram-managed-bots.md) — Telegram Bot API 9.6 reference (managed bots, login widget, webhook types)

---

## Running in Production

```bash
pnpm build

# API process
pnpm start

# Worker process (separate terminal or ECS task)
pnpm worker
```

Both processes use the same Docker image with different commands. The API process handles HTTP and webhook ingestion; the worker process handles LLM calls and Telegram replies. See [Architecture.md](./Architecture.md#2-process-topology) for ECS deployment details.
