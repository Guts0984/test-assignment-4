# Builds the image for the web app (Next.js). Two stages: a kitchen that builds, and a clean plate that runs.
# Build it from the repository root:  docker build -f apps/web/Dockerfile .

# ---------- STAGE 1: the kitchen ----------
FROM node:22-alpine AS build

RUN npm install -g pnpm@12.6.0
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @app/web...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @app/web build


# ---------- STAGE 2: the plate ----------
FROM node:22-alpine

ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 SHUTDOWN_TIMEOUT_MS=10000
WORKDIR /app

# The self-contained server, its static files, and the small wrapper that stops it politely.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node apps/web/docker-entry.mjs ./docker-entry.mjs

# Run as an ordinary user, not as root.
USER node
EXPOSE 3000
CMD ["node", "docker-entry.mjs"]
