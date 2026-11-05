# Builds the image for the worker (background jobs). Two stages: a kitchen that builds, and a clean plate that runs.
# Build it from the repository root:  docker build -f apps/worker/Dockerfile .

# ---------- STAGE 1: the kitchen ----------
FROM node:22-alpine AS build

# Prisma's generator needs OpenSSL.
RUN apk add --no-cache openssl && npm install -g pnpm@12.6.0
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
# The database schema must be here before the install: its postinstall step generates the database client from it.
COPY packages/db/package.json packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @app/worker...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db/src packages/db/src
COPY apps/worker apps/worker
RUN pnpm --filter @app/worker build

# Only the packages the worker needs when it runs.
RUN pnpm --filter @app/worker deploy --legacy --prod /out


# ---------- STAGE 2: the plate ----------
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
# "type": "module" makes Node treat dist/main.js as an ES module.
COPY --from=build --chown=node:node /repo/apps/worker/package.json ./package.json

# Run as an ordinary user, not as root.
USER node
CMD ["node", "dist/main.js"]
