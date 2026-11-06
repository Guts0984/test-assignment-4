# PLAN: ticket sales with seat selection

The assignment text (`test-assignment-4.md`) is the source of truth. This plan only orders the work.
Where the assignment is unclear, the decision is written down in "Decisions" below and in the README.

## How we work

1. Assignment first. Every phase ends by checking its requirements against the assignment text, not against this plan.
2. Tests must really test: they are written to break the code and find bugs, and each important test is checked by
   temporarily breaking the code (it must fail). Real PostgreSQL and Redis, never mocks, for api and worker.
3. One small step at a time. Each step is explained in plain language and shown; we wait for the go-ahead.
4. One commit per phase (the user commits; no git commands from Claude).
5. Do not touch the user's running `tickets` stack; own checks run in project `ticketscheck` on port 8081.

## Where we are

**Status (end of the overnight build): all 11 phases are implemented and verified.** The README holds the final description,
the caching table, the decisions, the known limits and the map of the 21 acceptance checks. What follows below is the
original plan, kept for the record.

(Original text of this section:)

Phase 0 is done: monorepo, NestJS `/health`, empty worker, Next.js shell, nginx (DNS refresh, page limit, cache,
BYPASS), compose, CI, smoke e2e. Old assignment-3 code to port from is in `../_assignment3-reference`
(cache, rate limiter, session store, password hasher, login guard, worker pipeline, `proxy.ts`, e2e patterns).

## Decisions (the assignment leaves these open)

| Question | Decision |
| --- | --- |
| Where does Prisma live | `packages/db` (schema, migrations, seed, client factory); api and worker both use it |
| Seat model | A row per (event, seat) in `event_seats` with `status` (`free`, `held`, `sold`), `hold_id`, `held_until`. Taking a seat is one atomic `UPDATE ... WHERE status = 'free' OR (status = 'held' AND held_until < now())`, so two buyers can never both get it: the row lock is the guarantee, plus `CHECK` constraints that keep the columns consistent and a unique `(event_id, seat_id)` on order items |
| What is a hold | One hold = one request = 1 to 6 seats of one event, 10 minutes. A user can have several holds on an event, but at most 6 seats in total (held plus sold). Enforced in the database (trigger with an advisory lock), not only in code |
| Expired holds | Reading the seat map and taking seats treat an expired hold as free at once. The worker only tidies up and notifies |
| Pay | Stub: `POST /holds/:id/pay` turns the hold into an order (`orders`, `order_items`) and marks the seats `sold` in one transaction; `DELETE /holds/:id` frees the seats |
| Past events | Not listed, and `GET /events/:id` of a past event still works (it is only hidden from the list) |
| Seat state cache | Never longer than 1 s, memory only; every change also drops the local copy and is pushed over Socket.IO |
| Socket.IO transport | WebSocket only (no long-polling), so no sticky sessions are needed behind nginx with two api instances |
| Rate limit of page requests (check 11) | Two layers: nginx `limit_req` per address for pages, and the web server passes the visitor address in signed headers on its api calls so the api limiter counts them too |
| Login protection (check 13) | Failed attempts counted per account **and address**, plus a loose account-wide limit; a stranger cannot lock the owner out |
| Dates (hydration) | Dates are formatted with a fixed locale and time zone, or on the client only, never with the viewer's own settings during server render |
| Test runner | Vitest everywhere |
| Classes | NestJS needs classes and decorators: the api is the one place where classes are allowed. Own logic stays in plain functions where natural. Injected classes use explicit `@Inject(...)` (no emitted type metadata) |

## Phases

### 1. Database (Prisma) and seed
- Prisma schema: `users`, `halls`, `seats`, `events`, `event_seats`, `holds`, `orders`, `order_items`, `idempotency_keys`, `outbox`.
- Custom SQL migration: constraints, the 6-seat trigger, outbox trigger (every event change writes a note, also a change made by hand in SQL), version bump.
- Seed: 2 halls (120 and 200 seats, rows and numbers), 100 events in 6 cities over the next 2 months, 3 users (one admin), passwords from the environment. Running it again changes nothing.
- Container that migrates and seeds once at startup (check 1).
- Tests: no seat taken twice under concurrency at the database level, constraints refuse bad data, seed runs twice with the same result, 6-seat rule under parallel requests.

### 2. API foundation
- Environment validated at startup; JSON logs with one request id (nginx to web to api to worker).
- Errors in one format; Zod pipe from `packages/shared`; **any bad input is 4xx, never 5xx** (NUL byte in a parameter, huge numbers, wrong types).
- Redis and PostgreSQL clients with timeouts; a restart of either does not stop the process and the service recovers by itself (checks 16).
- `/health` (alive) and `/ready` (PostgreSQL and Redis reachable); Swagger at `/docs`.
- SIGTERM: finish running requests, exit code 0 (check 18).
- Rate limit shared by both instances, by the real client address; a forged `X-Forwarded-For` has no effect; calls from the web server carry the visitor address in signed headers (check 12, 11).
- Tests: error format, 4xx for hostile input, restart of PostgreSQL and Redis (real containers), SIGTERM, rate limit shared by two instances.

### 3. Auth
- `POST /auth/register`, `/auth/login`, `/auth/logout`, `GET /me`; session in Redis, `httpOnly` cookie, `Secure` flag from the environment.
- Password hashing with a decoy check so unknown emails take the same time.
- Login protection against guessing that cannot lock out the owner (check 13).
- Tests: sessions, expiry, logout, wrong password, account lockout rules, the same answer for unknown and known emails.

### 4. Events and the two-level cache
- `GET /events` (city, q, from, to, cursor; past events hidden), `GET /events/:id` (404 if missing), `PATCH /events/:id` (admin only, `title` and `description`, `version`, 409 on conflict).
- Cache: memory plus Redis, generation numbers, one database query for 100 simultaneous cold requests, negative cache, a change on one instance is seen at once on the other (checks 3, 4, 6).
- Tests: the cache rules above with a counted database, two instances, the 409 under 20 editors, hostile ids.

### 5. Seats, holds, orders
- `GET /events/:id/seats` (free, held, sold; never cached longer than 1 s).
- `POST /events/:id/holds` with `Idempotency-Key`; 6 seats per user per event; `POST /holds/:id/pay`; `DELETE /holds/:id`; `GET /me/orders`.
- Tests: 200 simultaneous requests for the same 10 seats, every seat sold exactly once (check 7); the 7th seat is refused and a repeated key gives the same answer (check 8); a different body with the same key is 422; expiry frees the seats; someone else's hold looks like it does not exist.

### 6. Realtime (Socket.IO)
- Redis adapter so every change reaches watchers on either api instance; the connection uses the same session; a reconnecting client gets the current state.
- Tests: two instances, three clients, held/released/sold reach all; reconnect gets the full state; no session means no private data.

### 7. Worker
- Expire holds (idempotent), publish the seat changes, tell `web` to clear its cache after an event changes (signed request, retries with growing pauses, a second delayed clearing), restart loses nothing (check 10).
- Tests: expiry with real time, retries when `web` is down, two workers do not duplicate, restart in the middle.

### 8. Web
- Foundation: TanStack Query provider, layout and header (orders counter), access rules for closed pages with real 307/403 (`proxy.ts`), request id, Docker build with the 20 nearest events built ahead.
- Pages: `/` catalog (filters in URL, debounced search, old answer never overwrites a new one, `useInfiniteQuery`), `/events/[id]` (real 404, cached with tags), `/events/[id]/seats` (mouse and keyboard, Socket.IO updates), `/checkout/[holdId]` (timer, pay, cancel), `/me/orders`, `/login`, `/register` (React Hook Form + Zod), `/admin/events/[id]` (Server Action, conflict view keeps the typed text).
- Optimistic updates: seat choice, hold cancel, orders counter; quick repeated clicks never double-hold. Query keys and invalidation after a purchase (seats, orders, header).
- Cache rules: public data cached with tags, an edit shows within 5 s (checks 5, 14, 15); personal data never in a shared cache; no hydration errors; no api address or secret in client chunks (check 20).
- Tests: unit tests for the optimistic seat state and the search race; component behaviour.

### 9. Infrastructure and security pass
- nginx: websocket upgrade for Socket.IO, DNS refresh after the api containers are replaced (check 17), page limit, 5 s cache with `X-Cache-Status` (`HIT` / `BYPASS`).
- Compose: only nginx published; non-root images; build at `docker build`; migrations and seed once.

### 10. End-to-end and load tests
- Playwright: purchase from catalog to order; two browsers fighting for one seat (loser gets a rollback and a message, both maps update); 404; an edit in the admin form and by direct API call visible within 5 s; privacy with the nginx cache.
- Pass 3 times in a row on one stack without restart (the rate limiter state must not break repeated runs); Chrome, Firefox, WebKit; no hydration errors (check 19).
- Load test (autocannon): 200 requests for 10 seats; result in the README.

### 11. CI, README, final acceptance
- CI on every commit: lint, typecheck, tests, image builds, e2e; the last commit is green; the history of runs is kept.
- README: run (local and Docker), tests, load test, the caching table (what, where, how long, how cleared, worst staleness), what happens when PostgreSQL or Redis is down, decisions and known limits.
- Run the 21 acceptance checks on a clean clone, one by one, and fix what fails.

## The 21 acceptance checks and where they are covered

| # | Check | Phase |
| --- | --- | --- |
| 1 | `cp .env.example .env && docker compose up --build`, only nginx open | 1, 9 |
| 2 | typecheck, lint, tests, CI green | 11 |
| 3 | repeated and 100 cold `GET /events/:id` | 4 |
| 4 | `PATCH` on one instance, `GET` on the other | 4 |
| 5 | edit via form and API shows within 5 s | 4, 8 |
| 6 | `/events/9999` and `/events/abc` are 404 | 4, 8 |
| 7 | 200 requests for 10 seats | 5, 10 |
| 8 | 7th seat refused; same key gives one hold | 5 |
| 9 | two browsers, one seat | 6, 8, 10 |
| 10 | unpaid hold expires after 10 minutes, open maps update | 5, 6, 7 |
| 11 | 1000 different page URLs from one address hit a limit | 2, 9 |
| 12 | forged `X-Forwarded-For`, NUL byte | 2 |
| 13 | 10 wrong passwords do not lock the owner out | 3 |
| 14 | one user's orders and header never reach another or an anonymous visitor | 8, 9 |
| 15 | `X-Cache-Status` `HIT` / `BYPASS` | 9 |
| 16 | PostgreSQL then Redis restart | 2 |
| 17 | api containers replaced, nginx keeps working | 9 |
| 18 | SIGTERM to every service | 2, 7, 8 |
| 19 | e2e 3 times in a row, three browsers, no hydration errors | 10 |
| 20 | no api address or secrets in client chunks | 8 |
| 21 | README caching table matches real behaviour | 11 |

## Waiting for the user

- Confirm the decisions in the table above (especially: WebSocket-only Socket.IO, Vitest, classes only in the api,
  the seat model with a row per event and seat).
