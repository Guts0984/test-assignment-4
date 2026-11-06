# Event Tickets (seats on a hall map)

A ticket shop: a catalog of events, choosing real seats on a hall map, live updates of other buyers' choices, a stub payment, and an admin form to edit events.

```
browser ──► nginx ──► web  (Next.js 16, App Router)        ──► api (to render pages, with the visitor's address signed)
              │
              ├──► api ×2 (NestJS)  ──► PostgreSQL 16 (Prisma)
              │        │                Redis 7 (sessions, cache, rate limit, Socket.IO adapter)
              │        └── Socket.IO (WebSocket only) between the two instances through Redis
              └── /socket.io  ──► api
worker (BullMQ): releases expired holds, relays event changes → api cache + web cache
migrate (one-shot): applies the migrations and the seed, then exits
```

Only **nginx** is published to the outside (port `8080`).

## Run it

```bash
cp .env.example .env
docker compose up --build
```

Open <http://localhost:8080>. That is the only manual step: the one-shot `migrate` container applies the migrations and fills the seed data (running it again changes nothing), then the two api instances, the worker, the web app and nginx start.

| What | Where |
| --- | --- |
| The site | <http://localhost:8080> |
| API documentation (Swagger) | <http://localhost:8080/docs> (the OpenAPI document is at `/openapi.json`) |
| API | <http://localhost:8080/api/...> (nginx removes the `/api` prefix) |

### Demo accounts (from `.env.example`)

| Email | Role | Password variable | Demo value |
| --- | --- | --- | --- |
| `admin@example.com` | administrator | `SEED_ADMIN_PASSWORD` | `local-demo-admin-password` |
| `alice@example.com` | user | `SEED_USER_PASSWORD` | `local-demo-user-password` |
| `bob@example.com` | user | `SEED_USER_PASSWORD` | `local-demo-user-password` |

The seed creates 2 halls (`Main Hall` 8 rows × 15 = **120** seats, `Grand Hall` 10 rows × 20 = **200** seats) and **100** events in 6 cities (New York, Los Angeles, Chicago, Houston, Seattle, Miami) over the next ~2 months.

### Secrets

No secret is written in code, a Dockerfile or `docker-compose.yml`. They come from `.env` (`.env.example` holds clearly marked **demo** values for trying it out on your own machine). A service refuses to start when a secret is missing or too short (`INTERNAL_SECRET` needs 32+ characters). Compose has no `${VAR:-default}` fallbacks for secrets. The cookie's `Secure` flag is switched on with `COOKIE_SECURE=true` (when the site is served over https).

## Tests

```bash
pnpm install          # also generates the Prisma client; typecheck works right after, nothing has to be built first
pnpm typecheck        # all packages, from the root
pnpm lint             # includes React Hooks and Next.js rules
pnpm test             # unit tests + integration tests (they start a REAL PostgreSQL 16 and Redis 7 with Testcontainers: Docker must run)
pnpm e2e              # Playwright, against a running stack (docker compose up); BASE_URL=http://localhost:8080
pnpm loadtest         # 200 buyers, 10 seats (see below)
```

What the tests cover (all of them on real PostgreSQL / Redis, no mocks of either):

| Package | Tests |
| --- | --- |
| `packages/db` | no seat can be held twice under concurrency (200 parallel buyers, also at the SQL level), the 6-seats rule under parallel requests, every CHECK constraint, the event version race, the outbox, the seed twice and in parallel, password hashing against hostile stored values |
| `apps/api` | error format and hostile input (always 4xx), double sale (200 buyers × 10 seats over two instances), 6 seats per user, `Idempotency-Key`, `409` on a version conflict (20 editors), cache and its invalidation between two instances (one database query for 100 cold requests), rate limit shared by two instances, forged addresses, login protection, expiry, Socket.IO on two instances (held / released / sold, reconnect, anonymous), PostgreSQL / Redis restarts and freezes, `SIGTERM` of the real process |
| `apps/worker` | expiry of holds with real time, announcements, outbox relay with two workers, signed calls with retries, a restart in the middle, `SIGTERM` during a running job |
| `apps/web` | the optimistic seat state (quick repeated clicks, rollback, live changes), the search race (a slow old answer never replaces a newer one), the revalidation endpoint (signature), date formatting (no hydration differences), safe redirects |
| `e2e` | purchase from the catalog to an order; two browsers fighting for one seat (live rollback, and the server-side `409` rollback); `404`s; admin edit visible in the card and the list within 5 s (form and direct API call); a version conflict keeps the typed text; privacy through the nginx cache; `X-Cache-Status`; no hydration errors; no api address or secret in the client files; abuse limits |

The e2e suite runs **three times in a row on one stack without restarting it**, in Chromium, Firefox and WebKit (Safari's engine) — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

Every important guarantee was also checked by **breaking the code on purpose** (removing a lock, a trigger, a check ...) and confirming that a test fails.

## Load test

`pnpm loadtest` (autocannon, [`loadtest/run.mjs`](loadtest/run.mjs)): registers 200 buyers, then fires 200 requests **at the same moment**, buyer *n* wanting seat *n mod 10* of the same 10 seats, through nginx and both api instances. It then asks every buyer which seats are theirs and checks that each seat has exactly one owner.

Reading of "200 simultaneous requests for the same 10 seats": one user can hold at most 6 seats, so the 200 requests come from 200 different buyers, each asking for one of the 10 seats.

Result of one run on a laptop (the whole stack in Docker: nginx, two api instances, PostgreSQL, Redis):

```
event 33 "Stand-up: Nocturne", seats 123,124,125,126,127,128,129,130,131,132
200 buyers registered; waiting for the rate-limit window to pass ...

autocannon: 200 requests in 1.03 s
  latency  avg 619.68 ms, p50 657 ms, p97.5 851 ms, p99 851 ms, max 853 ms
  answers  201 created: 10, 409 refused: 190, other: 0  (errors 0, timeouts 0, non-2xx 190)
  result   10 of 10 seats have an owner; 10 are shown as held; owners per seat: 1,1,1,1,1,1,1,1,1,1

OK: every one of the 10 seats has exactly one owner.
```

Ten holds were created (one per seat) and 190 requests were refused with `409 SOLD_OUT`; no seat has two owners and no hold was left half made. The run is repeatable: every run picks a random upcoming event.

## The API

Swagger at `/docs`. Errors always look like `{ "code": "...", "message": "...", "details": { ... } }`.

| Method and path | Purpose |
| --- | --- |
| `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /me` | Session in Redis, `httpOnly` cookie `sid` |
| `GET /events?city=&q=&from=&to=&cursor=&limit=` | Upcoming events, filters, title search, cursor pagination |
| `GET /events/:id` | One event; `404` for anything that is not an existing event (also `abc`, `0`, `1.5`, ...) |
| `GET /events/:id/seats` | The hall: `free` / `held` / `sold`, and `mine`; never cached |
| `POST /events/:id/holds` | Hold 1–6 seats for 10 minutes; `Idempotency-Key` header is required |
| `POST /holds/:id/pay`, `DELETE /holds/:id` | Pay (stub) / give the seats back |
| `GET /me/orders` | The caller's orders |
| `PATCH /events/:id` | Admin only: `title`, `description`, `version`; `409` with the saved event on a conflict |
| `GET /health`, `GET /ready` | The process is alive / PostgreSQL and Redis are reachable |
| Socket.IO `/socket.io` | `watch {eventId}` → full map; messages `seats:changed` |

Additions beyond the table in the assignment (needed by the pages): `GET /holds/:id` (the payment page reads its own hold), and `myHoldIds` in the seat map (to get back to payment).

## Caching: what, where, how long, how it is dropped, how stale it can be

| Data | Where | How long | How it is dropped | Worst staleness |
| --- | --- | --- | --- | --- |
| `GET /events/:id` (and "not found") | api memory, then Redis | memory 5 s / 60 s in Redis; "not found" 3 s / 5 s | Every cache key contains a **generation number** kept in Redis (`gen:events`). `PATCH` raises it before answering, so all keys of both instances stop being used at once. The worker raises it too after any change, including a change made by hand in SQL | `PATCH`: **0** (the next read on either instance sees it). Change made directly in SQL: until the worker notices, ~1 s |
| `GET /events` pages | same two layers | memory 2 s / 15 s in Redis | same generation number. Events that started meanwhile are filtered out on every read | `PATCH`: 0. Elapsed time (an event starting): 0 (filtered) |
| Cold cache stampede | api memory + a short Redis lock | – | – | 100 identical requests on a cold cache cause **one** database query, even over two instances |
| Seat map `GET /events/:id/seats` | **not cached**; concurrent identical reads share one query | 0 s | – | 0 s (the limit allowed was 1 s) |
| Event pages and the list page (server side) | Next.js data cache with tags `events`, `event:<id>` | 5 s | `revalidateTag(..., { expire: 0 })` after an edit through the form, and when the worker calls the signed `/internal/revalidate` | form / API edit: shown within 5 s (usually at once) |
| Public pages for visitors without a session | nginx `proxy_cache` | 4 s (nginx counts whole seconds) | expires | ≤ 5 s |
| Anything with a session cookie, `/me`, `/checkout`, `/admin`, the api's private answers | **never** in a shared cache | – | – | – |
| Header (user, orders counter) | browser only (TanStack Query) | – | – | – |

If the worker is not running, the pages fall back to their own timers: an edit can then take up to about 9 s (Next.js' 5 s plus nginx' 4 s) to show in the card; the api's own answers are still current at once.

How privacy is kept: nginx caches only requests without the session cookie (`X-Cache-Status: HIT/MISS` for anonymous, `BYPASS` with a session and for the private pages); the user's pages and answers carry `Cache-Control: private, no-store`; the header and the orders are drawn in the browser, so no HTML kept by a shared cache contains personal data; Next.js' data cache is used only for public data, requested **without** the visitor's cookie.

## Protection and limits

* **Account creation** is limited per address too (1000 an hour, `REGISTER_MAX_PER_HOUR`); set the variable in `.env` to change it. CI raises it, because the browser and load tests create thousands of accounts from one address).
* **One rate limit for both instances**: a counter per visitor address in Redis (an atomic Lua script): 300 requests / 10 s by default, on every path (also unknown ones). `/health` and `/ready` are exempt.
* **The visitor's real address**: nginx overwrites `X-Forwarded-For` with the address it saw; the api trusts that header only from a private-network neighbour, and takes the entry added by the proxy, never the ones the browser wrote. A forged `X-Forwarded-For`, `X-Real-IP` or `X-End-User-IP` changes nothing.
* **Pages rendered by the web server**: calls that carry a visitor's own cookie also carry the visitor's address in `X-End-User-IP` **signed** (HMAC, timestamp, `INTERNAL_SECRET`); nginx removes these headers from anything coming from outside. Page rendering is limited at the door too: nginx `limit_req` per address (20 requests / s, burst 40 for pages; a separate higher one for Next.js data requests), so 1000 different page addresses from one address are refused with `429`. Public data fetched for the shared page cache carries no visitor address (it would make every visitor's copy different); that traffic is bounded by nginx's limit, the 5 s page cache, the api's caches and the single-flight loading.
* **Login protection that cannot lock the owner out**: wrong passwords are counted per visitor address **and account** (20 per 15 min) and per address in total (200). Nothing is ever blocked per account alone. A correct login clears the count for that address and account only; logging in to your own account never washes away guesses made at someone else's. A 10 s burst limit stops parallel guessing. Unknown emails are checked against a decoy hash so they take as long as a wrong password.
* Sessions: 256-bit random id; Redis keeps only its SHA-256; sliding expiry (7 days); `httpOnly`, `SameSite=Lax`.
* Every input is validated with the Zod schemas of `packages/shared`; a NUL byte (`%00`, `\u0000`) anywhere is a `400`; the Socket.IO handshake refuses a foreign `Origin`.

## What happens when PostgreSQL or Redis is down

Nothing stops the processes; they recover by themselves. Every call to either has a timeout (PostgreSQL: 3 s to get a connection, 5–6 s per query; Redis: 3 s to connect, 2 s per command), so a request never hangs for more than a few seconds.

| | PostgreSQL down or restarting | Redis down or restarting |
| --- | --- | --- |
| `GET /health` | `200` (process alive) | `200` |
| `GET /ready` | `503` | `503` |
| API requests | `503` + `Retry-After` (never `500`) | requests that need sessions / the cache generation → `503`; public event reads fall back to the database (slower, never wrong); the rate limiter lets requests through while it cannot count (logged) |
| Recovery | the pool reconnects on its own; no restart | the client reconnects with growing pauses; Socket.IO clients re-ask for the whole map on reconnect |
| Worker | jobs fail and are retried by BullMQ; nothing is lost (state is in PostgreSQL / Redis) | BullMQ reconnects; scheduled jobs live in Redis |
| Web | pages whose data cannot be read render an error state (one block does not break the page) | same |

`SIGTERM` to the api, the worker or the web server: running requests / jobs finish, then the process exits with code `0` (tested on the real processes).

## Decisions and known limitations

Decisions where the assignment left room (it asks to record them here):

* **Seat model.** One row per (event, seat) in `event_seats` with a status. A seat is taken by one `UPDATE ... WHERE status = 'FREE' OR the hold expired` after locking the rows in a fixed order, all-or-nothing. The database also refuses by itself (a trigger) to give a held or sold seat to anyone else, even to a careless `UPDATE`, and a unique `(event, seat)` pair on order lines is a second guard. The 6-seat rule (held + bought, per user per event) is a database trigger with a per-user lock.
* **A hold** is one request for 1–6 seats and lasts 10 minutes (`HOLD_TTL_SECONDS`). A user may have several holds on an event; the 6 seats count all of them. An expired hold counts as free immediately — in the seat map, in taking seats and in paying — the worker only tidies up and announces.
* **Paying** is a stub that always succeeds, if the hold is still valid. Paying twice returns the same order; paying and cancelling at the same moment: exactly one wins.
* **Past events** are not listed, but their page still opens.
* **"200 requests for 10 seats"**: see the load test above.
* **Idempotency**: the first request with a key does the work; the unique `(user, key)` decides who is first; repeats get the same stored answer (also a stored `409`), a different request with the same key is `422`, a failure of ours (`5xx`) is not stored.
* **Socket.IO is WebSocket-only** (no long-polling), so no sticky sessions are needed behind nginx with two instances; the Redis adapter carries messages between them. A page that reconnects asks for the whole map again; changes that arrive while the map is on its way are applied on top of it.
* **The 20 nearest events are built when the site is built.** A Docker build has no running api next to it, so `generateStaticParams` uses ids 1–20 then (the seed creates events in time order); those pages first show the shell, the browser loads the facts, and the server rebuilds them within 5 s. With the api reachable at build time the 20 nearest events are used.
* **Dates** are always formatted with a fixed locale and UTC (`en-US`, "Nov 20, 2026, 6:00 PM UTC"), so the server and every browser render the same text.
* **Classes** appear only in the api (NestJS is built on them); everything else is plain functions.

Known limitations:

* A change made straight in SQL is picked up by the api's cache and the web's cache when the worker relays the outbox note (about a second), not instantly.
* Raising the cache generation invalidates **all** cached events, not just the changed one (simple and always correct; events change rarely).
* Login guessing is limited per address. Someone behind the same network address as the owner shares the owner's count for that account until it expires (15 min); a guesser with many addresses is slowed by scrypt but not stopped.
* The rate limiter fails open while Redis is unreachable.
* The pre-built pages of the 20 nearest events show a short loading state first when the api was unreachable during the build.
* Prices and refunds do not exist (the assignment does not ask for them); a sold seat is final.
* The Docker setup runs a single PostgreSQL and a single Redis (no replicas).

## The 21 acceptance checks and where each one is verified

| # | Check | Verified by |
| --- | --- | --- |
| 1 | `cp .env.example .env && docker compose up --build`, only nginx open | a clean `git clone` was built and started this way; `docker ps` shows one published port; CI does the same |
| 2 | typecheck from the root, lint, tests, CI | `pnpm typecheck && pnpm lint && pnpm test`; a clean clone typechecks right after `pnpm install`; `.github/workflows/ci.yml` |
| 3 | repeated and 100 cold `GET /events/:id` | `apps/api/test/events.test.ts` (counts the real SQL statements: exactly one for 100 cold requests over two instances; median warm answer under 15 ms) |
| 4 | `PATCH` on one instance, `GET` on the other | `events.test.ts` (25 alternating writes, each read immediately on the other instance) |
| 5 | an edit shows within 5 s (form and API) | `e2e/tests/admin.spec.ts` |
| 6 | `/events/9999` and `/events/abc` are 404 | `e2e/tests/notfound.spec.ts` (GET and HEAD, page and api), `events.test.ts` |
| 7 | 200 requests for 10 seats | `apps/api/test/holds.test.ts`, `packages/db/test/seat-race.test.ts` (also directly in SQL), `pnpm loadtest` |
| 8 | the 7th seat is refused; the same `Idempotency-Key` gives one hold | `holds.test.ts` |
| 9 | two browsers, one seat | `e2e/tests/contest.spec.ts`, `apps/api/test/realtime.test.ts` |
| 10 | an unpaid hold expires after 10 minutes, open maps update | `apps/worker/test/worker.test.ts` (real time), and a live check on the running stack (the worker's `free` message reached an open Socket.IO client) |
| 11 | 1000 different page addresses from one address | `e2e/tests/zz-limits.spec.ts` (nginx answers `429`), `apps/api/test/rate-limit.test.ts` (the api counterpart) |
| 12 | a forged `X-Forwarded-For`; a NUL byte | `zz-limits.spec.ts`, `rate-limit.test.ts`, `errors.test.ts`, `events.test.ts` |
| 13 | 10 wrong passwords do not lock the owner out | `zz-limits.spec.ts`, `apps/api/test/auth.test.ts` |
| 14 | one user's orders and header never reach another user or an anonymous visitor | `e2e/tests/privacy.spec.ts`, `holds.test.ts` |
| 15 | `X-Cache-Status` `HIT` / `BYPASS` | `privacy.spec.ts` |
| 16 | PostgreSQL then Redis restart | `apps/api/test/resilience.test.ts` (restarts and freezes of real containers) and a live check on the running stack |
| 17 | api containers recreated, nginx keeps working | a live check on the running stack (new addresses, nginx not restarted) |
| 18 | `SIGTERM` to every service | `apps/api/test/process.test.ts` (a request that is half sent is finished first), `apps/worker/test/process.test.ts` (a running job is finished first), and a live check: every container exits with code 0 |
| 19 | e2e three times in a row; Chrome, Firefox, Safari; no hydration errors | CI runs `pnpm e2e` three times on one stack in Chromium, Firefox and WebKit; `e2e/tests/hydration.spec.ts` |
| 20 | no api address or secret in the client files | `e2e/tests/bundle.spec.ts` |
| 21 | the caching table matches the real behaviour | the table above was written from the code and is exercised by the tests of checks 3, 4 and 5 |

## Repository

```
apps/api         NestJS api (two instances behind nginx)
apps/worker      BullMQ jobs
apps/web         Next.js site
packages/shared  Zod schemas and types shared by api, worker and web
packages/db      Prisma schema, SQL rules (triggers, constraints), seed, database tests
infra/nginx      nginx configuration
e2e              Playwright tests against the running stack
loadtest         autocannon script
```
