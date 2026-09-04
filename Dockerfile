# MortMortgage application container (task-045 — §7.1, NFR-026, AC-53).
#
# Multi-stage build with three runnable targets:
#   runner (default) — the production web app: Next.js standalone output,
#                      non-root, `node server.js` on port 3083.
#   worker           — the background-job worker (src/worker/index.ts):
#                      full toolchain image (tsx + prisma CLI), non-root.
#                      Also the exec target for one-command migrate+seed:
#                        docker compose exec worker npm run db:setup
#   builder          — internal build stage.
#
# Debian slim (glibc) base: Prisma engines + argon2 prebuilds work out of the
# box; openssl is required by the Prisma engine at runtime.

# --- deps: production + dev dependencies (the build needs both) ---------------
FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: prisma client + Next.js production build (standalone) -----------
FROM deps AS builder
COPY . .
RUN npx prisma generate
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT_STANDALONE=1
RUN npm run build

# --- worker: background jobs + migrate/seed toolchain (non-root) --------------
FROM builder AS worker
ENV NODE_ENV=production
USER node
CMD ["npx", "tsx", "src/worker/index.ts"]

# --- runner (default): minimal production web app (non-root) ------------------
FROM node:22-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3083 \
    HOSTNAME=0.0.0.0
# Standalone output carries its traced node_modules; the generated Prisma
# client + engine are copied explicitly (belt and braces for engine tracing).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
USER node
EXPOSE 3083
# No shell in the healthcheck target — probe with node itself. /api/health is
# public and returns 503 until database AND storage checks pass (NFR-001).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://localhost:3083/api/health').then((r)=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
