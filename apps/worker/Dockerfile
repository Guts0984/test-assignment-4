# Builds the image for the worker (background jobs). Two stages: a kitchen that builds, and a clean plate that runs.
# Build it from the repository root:  docker build -f apps/worker/Dockerfile .

# ---------- STAGE 1: the kitchen ----------
FROM node:22-alpine AS build

RUN npm install -g pnpm@12.6.0
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @app/worker...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/worker apps/worker
# Everything the worker needs is compiled into one file (dist/main.js).
RUN pnpm --filter @app/worker build


# ---------- STAGE 2: the plate ----------
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist

# Run as an ordinary user, not as root.
USER node
CMD ["node", "dist/main.js"]
