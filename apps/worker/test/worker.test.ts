import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { SOCKET_EVENTS, seatsChangedSchema, type SeatsChanged } from "@app/shared";
import { verifyInternalRequest } from "@app/shared/internal";
import { Client } from "pg";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { io as connectClient, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { parseEnv, type Env } from "../src/env";
import { expireHolds, relayOutbox } from "../src/jobs";
import { startWorker, type RunningWorker } from "../src/worker";

// Real PostgreSQL, real Redis, real BullMQ, real Socket.IO.

let sql: Client;
let databaseUrl: string;
let redis: Redis;
const secret = inject("internalSecret");
const running: RunningWorker[] = [];
const stoppers: Array<() => Promise<void> | void> = [];

function withDatabase(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

beforeAll(async () => {
  const adminUrl = inject("pgAdminUrl");
  const name = `w_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template_seeded`);
  await admin.end();
  databaseUrl = withDatabase(adminUrl, name);
  sql = new Client({ connectionString: databaseUrl });
  await sql.connect();
  redis = new Redis(inject("redisUrl"));
  await redis.flushall();
});
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
  for (const worker of running.splice(0)) await worker.close();
  await redis.flushall();
});
afterAll(async () => {
  await sql.end();
  redis.disconnect();
});

function env(overrides: Record<string, string> = {}): Env {
  const result = parseEnv({
    LOG_LEVEL: "silent",
    HEALTH_PORT: "0",
    DATABASE_URL: databaseUrl,
    REDIS_URL: inject("redisUrl"),
    INTERNAL_SECRET: secret,
    WEB_URL: "http://127.0.0.1:9",
    EXPIRE_EVERY_MS: "200",
    OUTBOX_EVERY_MS: "200",
    REVALIDATE_AGAIN_AFTER_MS: "700",
    REVALIDATE_RETRY_MS: "50",
    ...overrides,
  });
  if (!result.ok) throw new Error(result.problems.join(", "));
  return result.env;
}
async function start(overrides: Record<string, string> = {}): Promise<RunningWorker> {
  const worker = await startWorker(env(overrides));
  running.push(worker);
  return worker;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(what: string, probe: () => Promise<T | false | null | undefined>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(50);
  }
}

// ---------- helpers for data ----------
async function user(): Promise<string> {
  const row = await sql.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`w${randomUUID().slice(0, 8)}@test.local`]);
  return row.rows[0]?.id as string;
}
let nextEvent = 0;
const freshEvent = () => 20 + ++nextEvent;
/** A hold with `seats` seats held for `minutes` minutes; negative means it ran out that long ago. */
async function holdSeats(userId: string, eventId: number, seats: number, startSeat: number, secondsLeft: number): Promise<{ holdId: string; seatIds: number[] }> {
  const holdId = randomUUID();
  await sql.query(
    `INSERT INTO holds (id, user_id, event_id, created_at, expires_at) VALUES ($1, $2, $3, now() - interval '20 minutes', now() + make_interval(secs => $4))`,
    [holdId, userId, eventId, secondsLeft],
  );
  const picked = await sql.query<{ seat_id: number }>(`SELECT seat_id FROM event_seats WHERE event_id = $1 ORDER BY seat_id OFFSET $2 LIMIT $3`, [eventId, startSeat, seats]);
  const seatIds = picked.rows.map((row) => row.seat_id);
  await sql.query(
    `UPDATE event_seats SET status = 'HELD', user_id = $1, hold_id = $2, held_until = now() + make_interval(secs => $5) WHERE event_id = $3 AND seat_id = ANY($4)`,
    [userId, holdId, eventId, seatIds, secondsLeft],
  );
  return { holdId, seatIds };
}
const statusOf = async (eventId: number, seatIds: number[]) =>
  (await sql.query<{ status: string }>(`SELECT status FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2) ORDER BY seat_id`, [eventId, seatIds])).rows.map((row) => row.status);

// ---------- a Socket.IO server like the api's, to watch what the worker announces ----------
async function hallWatcher(eventId: number): Promise<{ messages: SeatsChanged[] }> {
  const http: HttpServer = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  const pub = new Redis(inject("redisUrl"));
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));
  io.on("connection", (socket) => socket.on("watch", async (_payload, ack: () => void) => (await socket.join(`event:${eventId}`), ack())));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const client: Socket = connectClient(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false });
  const messages: SeatsChanged[] = [];
  client.on(SOCKET_EVENTS.seatsChanged, (raw: unknown) => messages.push(seatsChangedSchema.parse(raw)));
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  await client.timeout(5000).emitWithAck("watch", {});
  stoppers.push(async () => {
    client.disconnect();
    await new Promise<void>((resolve) => void io.close(() => resolve()));
    pub.disconnect();
    sub.disconnect();
  });
  return { messages };
}

describe("expiring holds", () => {
  it("frees the seats of a hold whose time is up - and only those - and tells the people looking at the hall", async () => {
    const [alice, bob] = [await user(), await user()];
    const eventId = freshEvent();
    const gone = await holdSeats(alice, eventId, 3, 0, -5);
    const alive = await holdSeats(bob, eventId, 2, 10, 600);
    const watcher = await hallWatcher(eventId);
    const worker = await start();

    await until("expired seats freed", async () => (await statusOf(eventId, gone.seatIds)).every((s) => s === "FREE"));
    expect(await statusOf(eventId, alive.seatIds)).toEqual(["HELD", "HELD"]); // the other hold is untouched
    const rows = await sql.query(`SELECT id, status FROM holds WHERE id = ANY($1)`, [[gone.holdId, alive.holdId]]);
    expect(Object.fromEntries(rows.rows.map((row) => [row.id, row.status]))).toEqual({ [gone.holdId]: "EXPIRED", [alive.holdId]: "ACTIVE" });
    const freed = await sql.query(`SELECT user_id, hold_id, held_until FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2)`, [eventId, gone.seatIds]);
    expect(freed.rows.every((row) => row.user_id === null && row.hold_id === null && row.held_until === null)).toBe(true);

    await until("announcement", async () => watcher.messages.length > 0);
    expect(watcher.messages[0]?.eventId).toBe(eventId);
    expect(watcher.messages.flatMap((m) => m.changes.map((c) => c.seatId)).sort()).toEqual([...gone.seatIds].sort());
    expect(watcher.messages.flatMap((m) => m.changes).every((c) => c.status === "free")).toBe(true);
    await worker.close();
  });

  it("a hold that runs out while the worker is running is released within seconds (acceptance check 10)", async () => {
    const alice = await user();
    const eventId = freshEvent();
    const soon = await holdSeats(alice, eventId, 2, 0, 1.2);
    await start();
    expect(await statusOf(eventId, soon.seatIds)).toEqual(["HELD", "HELD"]);
    await until("seats freed after the time ran out", async () => (await statusOf(eventId, soon.seatIds)).every((s) => s === "FREE"), 6000);
  });

  it("is idempotent: running it again, or twice at the same moment, frees each seat and announces it exactly once", async () => {
    const alice = await user();
    const eventId = freshEvent();
    const gone = await holdSeats(alice, eventId, 4, 0, -5);
    const watcher = await hallWatcher(eventId);
    const worker = await start({ EXPIRE_EVERY_MS: "3600000" }); // the schedule stays out of the way: we call the job by hand
    const results = await Promise.all([expireHolds(worker.ctx), expireHolds(worker.ctx), expireHolds(worker.ctx), expireHolds(worker.ctx)]);
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(4);
    expect(await expireHolds(worker.ctx)).toBe(0);
    await sleep(500);
    expect(watcher.messages.flatMap((m) => m.changes)).toHaveLength(4);
    expect(await statusOf(eventId, gone.seatIds)).toEqual(["FREE", "FREE", "FREE", "FREE"]);
  });

  it("does not take away seats that someone else took over after the old hold ran out", async () => {
    const [alice, bob] = [await user(), await user()];
    const eventId = freshEvent();
    const old = await holdSeats(alice, eventId, 1, 0, -5);
    const takenOver = await holdSeats(bob, eventId, 1, 0, 600); // same seat, new hold - what the api does for an expired seat
    expect(takenOver.seatIds).toEqual(old.seatIds);
    const worker = await start({ EXPIRE_EVERY_MS: "3600000" });
    await expireHolds(worker.ctx);
    expect(await statusOf(eventId, old.seatIds)).toEqual(["HELD"]);
    const owner = await sql.query(`SELECT user_id FROM event_seats WHERE event_id = $1 AND seat_id = $2`, [eventId, old.seatIds[0]]);
    expect(owner.rows[0].user_id).toBe(bob);
    expect((await sql.query(`SELECT status FROM holds WHERE id = $1`, [old.holdId])).rows[0].status).toBe("EXPIRED");
  });

  it("never touches a seat that has been bought", async () => {
    const alice = await user();
    const eventId = freshEvent();
    const bought = await holdSeats(alice, eventId, 2, 0, -5);
    await sql.query(`UPDATE event_seats SET status = 'SOLD', hold_id = NULL, held_until = NULL WHERE event_id = $1 AND seat_id = ANY($2)`, [eventId, bought.seatIds]);
    await sql.query(`UPDATE holds SET status = 'PAID' WHERE id = $1`, [bought.holdId]);
    const worker = await start({ EXPIRE_EVERY_MS: "3600000" });
    expect(await expireHolds(worker.ctx)).toBe(0);
    expect(await statusOf(eventId, bought.seatIds)).toEqual(["SOLD", "SOLD"]);
  });

  it("paying at the same moment as the expiry: exactly one of them wins, and the data stays consistent", async () => {
    for (let round = 0; round < 6; round++) {
      const alice = await user();
      const eventId = freshEvent();
      const h = await holdSeats(alice, eventId, 2, 0, -1);
      const worker = await start({ EXPIRE_EVERY_MS: "3600000" });
      // "pay": what the api does - lock the hold, and sell the seats if it is still ACTIVE
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const pay = (async () => {
        await client.query("BEGIN");
        const locked = await client.query(`SELECT status FROM holds WHERE id = $1 FOR UPDATE`, [h.holdId]);
        if (locked.rows[0].status === "ACTIVE") {
          await client.query(`UPDATE event_seats SET status = 'SOLD', hold_id = NULL, held_until = NULL WHERE hold_id = $1 AND status = 'HELD'`, [h.holdId]);
          await client.query(`UPDATE holds SET status = 'PAID' WHERE id = $1`, [h.holdId]);
        }
        await client.query("COMMIT");
        return locked.rows[0].status as string;
      })();
      await Promise.all([pay, expireHolds(worker.ctx)]);
      await client.end();
      const hold = (await sql.query(`SELECT status FROM holds WHERE id = $1`, [h.holdId])).rows[0].status as string;
      const seats = await statusOf(eventId, h.seatIds);
      if (hold === "PAID") expect(seats).toEqual(["SOLD", "SOLD"]);
      else {
        expect(hold).toBe("EXPIRED");
        expect(seats).toEqual(["FREE", "FREE"]);
      }
      await worker.close();
      running.pop();
    }
  });
});

describe("telling the web app that an event changed", () => {
  type Seen = { tags: string[]; trusted: boolean };
  /** A pretend web app. It answers `failFirst` requests with 503, then 200, and records what it got. */
  async function fakeWeb(failFirst: number, port = 0): Promise<{ url: string; seen: Seen[]; attempts: () => number; stop: () => Promise<void> }> {
    const seen: Seen[] = [];
    let attempts = 0;
    const server = createServer((req: IncomingMessage, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        attempts++;
        if (req.url !== "/internal/revalidate" || req.method !== "POST") return res.writeHead(404).end();
        if (attempts <= failFirst) return res.writeHead(503).end();
        const check = verifyInternalRequest(secret, req.headers);
        seen.push({ tags: (JSON.parse(body) as { tags: string[] }).tags, trusted: check.trusted });
        res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : 0;
    return { url: `http://127.0.0.1:${actual}`, seen, attempts: () => attempts, stop: () => new Promise<void>((resolve) => (server.closeAllConnections(), void server.close(() => resolve()))) };
  }

  async function changeEvent(id: number, title: string): Promise<void> {
    await sql.query(`UPDATE events SET title = $1 WHERE id = $2`, [title, id]);
  }
  const unprocessed = async () => (await sql.query(`SELECT 1 FROM outbox WHERE processed_at IS NULL`)).rowCount ?? 0;

  it("a change leaves a note; the worker raises the cache generation and calls the web app - now and once more later - signed", async () => {
    await sql.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`); // the seed's 100 notes are not what we test
    const web = await fakeWeb(0);
    stoppers.push(web.stop);
    const before = Number((await redis.get("gen:events")) ?? 0);
    await start({ WEB_URL: web.url });
    await changeEvent(7, "Changed in SQL");
    await until("both calls arrived", async () => web.seen.length >= 2);
    expect(web.seen.slice(0, 2).every((call) => call.trusted)).toBe(true);
    expect(web.seen[0]?.tags).toEqual(["event:7", "events"]);
    expect(Number(await redis.get("gen:events"))).toBeGreaterThan(before);
    await until("note marked as done", async () => (await unprocessed()) === 0);
  });

  it("a call that carries a wrong signature is not trusted by the checker (so the web app can refuse it)", () => {
    expect(verifyInternalRequest(secret, { "x-internal-timestamp": String(Date.now()), "x-internal-signature": "00".repeat(32) }).trusted).toBe(false);
  });

  it("retries with growing pauses while the web app is unavailable, and delivers when it comes back (acceptance: retries)", async () => {
    await sql.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
    const web = await fakeWeb(4);
    stoppers.push(web.stop);
    await start({ WEB_URL: web.url, REVALIDATE_AGAIN_AFTER_MS: "3600000" });
    await changeEvent(8, "Needs retries");
    await until("delivered after failures", async () => web.seen.length >= 1, 10_000);
    expect(web.attempts()).toBeGreaterThanOrEqual(5);
  });

  it("when the web app is completely down (nothing listens), the call is kept and delivered once it is back", async () => {
    await sql.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
    const first = await fakeWeb(0);
    const port = Number(new URL(first.url).port);
    await first.stop(); // nobody listens on this port now
    await start({ WEB_URL: first.url, REVALIDATE_AGAIN_AFTER_MS: "3600000" });
    await changeEvent(9, "Web was down");
    await sleep(1500);
    const second = await fakeWeb(0, port);
    stoppers.push(second.stop);
    await until("delivered after the web app returned", async () => second.seen.length >= 1, 12_000);
    expect(second.seen[0]?.tags).toEqual(["event:9", "events"]);
  });

  it("a worker restarted in the middle loses nothing: queued calls survive in Redis", async () => {
    await sql.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
    const web = await fakeWeb(0);
    stoppers.push(web.stop);
    // The web address is wrong at first, so the call fails and waits for a retry ...
    const unlucky = await start({ WEB_URL: "http://127.0.0.1:9", REVALIDATE_AGAIN_AFTER_MS: "3600000", REVALIDATE_RETRY_MS: "5000" });
    await changeEvent(10, "Survives a restart");
    await until("note relayed", async () => (await unprocessed()) === 0);
    await unlucky.close(); // ... the worker is stopped ...
    running.pop();
    await start({ WEB_URL: web.url, REVALIDATE_AGAIN_AFTER_MS: "3600000" }); // ... and a new one starts with the right address
    await until("delivered by the new worker", async () => web.seen.length >= 1, 15_000);
    expect(web.seen[0]?.tags).toEqual(["event:10", "events"]);
  }, 40_000);

  it("two workers share the notes: each change is relayed once, and the same note is never queued twice", async () => {
    await sql.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
    const web = await fakeWeb(0);
    stoppers.push(web.stop);
    const w1 = await start({ WEB_URL: web.url, REVALIDATE_AGAIN_AFTER_MS: "3600000", OUTBOX_EVERY_MS: "3600000" });
    const w2 = await start({ WEB_URL: web.url, REVALIDATE_AGAIN_AFTER_MS: "3600000", OUTBOX_EVERY_MS: "3600000" });
    for (let i = 0; i < 10; i++) await changeEvent(11, `Burst ${i}`);
    // Several relays at once - the two workers' own scheduled runs may join in as well. Whoever gets a note, it is handled once.
    const relayed = await Promise.all([relayOutbox(w1.ctx), relayOutbox(w2.ctx), relayOutbox(w1.ctx), relayOutbox(w2.ctx)]);
    await until("every note handled", async () => (await unprocessed()) === 0);
    await until("10 immediate calls delivered", async () => web.seen.length >= 10);
    await sleep(500);
    expect(web.seen).toHaveLength(10); // not 20: no note was handled by two workers
    expect(relayed.every((n) => n >= 0 && n <= 10)).toBe(true);
  });

  it("relaying the same note again (a crash after queuing, before marking it done) does not queue the calls again", async () => {
    await sql.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
    const worker = await start({ WEB_URL: "http://127.0.0.1:9", OUTBOX_EVERY_MS: "3600000", REVALIDATE_AGAIN_AFTER_MS: "3600000", REVALIDATE_RETRY_MS: "3600000" });
    await changeEvent(12, "Once");
    await relayOutbox(worker.ctx);
    const queued = async () => worker.ctx.revalidateQueue.getJobCounts("waiting", "delayed", "active", "failed", "completed");
    const before = Object.values(await queued()).reduce((sum, n) => sum + n, 0);
    await sql.query(`UPDATE outbox SET processed_at = NULL WHERE payload->>'eventId' = '12' AND payload->>'op' = 'UPDATE'`); // as if the "done" mark had been lost
    await relayOutbox(worker.ctx);
    const after = Object.values(await queued()).reduce((sum, n) => sum + n, 0);
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  });
});

describe("the process", () => {
  it("starts the schedules once even if started twice (no doubled work)", async () => {
    await start();
    await start();
    await start();
    const queue = new Queue("maintenance", { connection: new Redis(inject("redisUrl"), { maxRetriesPerRequest: null }) });
    try {
      const names = (await queue.getJobSchedulers()).map((scheduler) => scheduler.key).sort();
      expect(names).toEqual(["clean-old-notes", "expire-holds", "relay-outbox"]);
    } finally {
      await queue.close();
    }
  });
});
