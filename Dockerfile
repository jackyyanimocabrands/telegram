# ─────────────────────────────────────────────
# Stage 1: builder
# Install ALL deps (including devDeps) and compile TypeScript.
# ─────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Enable corepack so pnpm is available without a separate install step.
# Pin to the exact version declared in packageManager to guarantee reproducibility.
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

# Copy manifest + lockfile first — Docker layer caching means pnpm install
# only re-runs when these files change, not on every source change.
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# Copy source and tsconfig, then compile
COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm run build

# ─────────────────────────────────────────────
# Stage 2: runner (production image)
# Lean image: prod-only deps, compiled output, non-root user.
# ─────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Create a non-root group + user to run the process.
# Running as root inside a container is a security anti-pattern and
# violates most CIS benchmarks / SOC 2 container hardening controls.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Enable corepack for pnpm prod install
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

# Install production dependencies only.
# --frozen-lockfile ensures the lockfile is never mutated at runtime.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from the builder stage
COPY --from=builder /app/dist ./dist

# Copy DB migrations — runMigrations() reads these at startup
COPY migrations/ ./migrations/

# Copy static assets served by Express
COPY public/ ./public/

# Drop privileges — all subsequent RUN/CMD/ENTRYPOINT commands run as appuser
USER appuser

EXPOSE 3000

# ECS / ALB native health check.
# --start-period=60s gives the service time to run migrations and register bots
# before the container is declared unhealthy on first deploy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
