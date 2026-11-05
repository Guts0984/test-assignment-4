# One-shot image that prepares the database: applies the migrations, then runs the seed.
# Both steps are safe to repeat (migrations are tracked, the seed changes nothing the second time).
# Build it from the repository root:  docker build -f packages/db/Dockerfile .

# ---------- STAGE 1: the kitchen ----------
FROM node:22-alpine AS build

RUN npm install -g pnpm@12.6.0
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The schema must be here before the install: its postinstall step generates the database client from it.
COPY packages/db/package.json packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma
RUN pnpm install --frozen-lockfile --prod --filter @app/db...

COPY tsconfig.base.json ./
COPY packages/db/src packages/db/src


# ---------- STAGE 2: the plate ----------
FROM node:22-alpine

# The Prisma migration tool needs OpenSSL.
RUN apk add --no-cache openssl

ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/packages/db

# Run as an ordinary user, not as root.
USER node
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node_modules/.bin/tsx src/seed-cli.ts"]
