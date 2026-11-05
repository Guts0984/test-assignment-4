# Builds the image for the api (NestJS). Two stages: a kitchen that builds, and a clean plate that runs.
# Build it from the repository root:  docker build -f apps/api/Dockerfile .

# ---------- STAGE 1: the kitchen ----------
FROM node:22-alpine AS build

RUN npm install -g pnpm@12.6.0
WORKDIR /repo

# Dependencies first, so this layer is reused as long as the package files do not change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @app/api...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @app/api build

# Only the packages the api needs when it runs.
RUN pnpm --filter @app/api deploy --legacy --prod /out


# ---------- STAGE 2: the plate ----------
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist

# Run as an ordinary user, not as root.
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
