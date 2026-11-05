# Event Tickets (seat selection)

Work in progress. See the assignment for the full list of requirements.

## Run it

```bash
cp .env.example .env
docker compose up --build
```

Open http://localhost:8080 (nginx is the only published port).

## Repository

```
apps/api         NestJS api (two instances behind nginx)
apps/worker      background jobs
apps/web         Next.js site
packages/shared  Zod schemas and types shared by api, worker and web
infra/nginx      nginx configuration
e2e              Playwright tests against the running stack
```

## Checks

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```
