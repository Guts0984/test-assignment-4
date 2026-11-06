import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createDb, seed } from "@app/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app";
import { createInfra } from "../src/infra/infra";
import { parseEnv } from "../src/env";
import { signInternalRequest } from "@app/shared/internal";
import { call, login, type Reply } from "./helpers";

// A restart or a freeze of PostgreSQL / Redis must not stop the api, must not make requests hang, and the service must
// come back by itself. These tests use their own containers with FIXED ports (so a restarted container is found again).

const dbPackage = fileURLToPath(new URL("../../../packages/db", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "pipe" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let base: string;
let closeApp: () => Promise<void>;
const passwords = { admin: `a-${randomBytes(9).toString("hex")}`, user: `u-${randomBytes(9).toString("hex")}` };
const uncaught: unknown[] = [];

beforeAll(async () => {
  process.on("uncaughtException", (error) => uncaught.push(error));
  process.on("unhandledRejection", (error) => uncaught.push(error));

  const [pgPort, redisPort] = await Promise.all([freePort(), freePort()]);
  const pgPassword = randomBytes(12).toString("hex");
  const redisPassword = randomBytes(12).toString("hex");
  postgres = await new PostgreSqlContainer("postgres:16-alpine").withPassword(pgPassword).withExposedPorts({ container: 5432, host: pgPort }).start();
  redis = await new GenericContainer("redis:7-alpine")
    .withCommand(["redis-server", "--requirepass", redisPassword, "--appendonly", "yes"])
    .withExposedPorts({ container: 6379, host: redisPort })
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();

  const databaseUrl = postgres.getConnectionUri();
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { cwd: dbPackage, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" });
  const seeding = createDb(databaseUrl, { statementTimeoutMs: 120_000 });
  await seed(seeding, { adminPassword: passwords.admin, userPassword: passwords.user });
  await seeding.$disconnect();

  const parsed = parseEnv({
    API_PORT: "0",
    LOG_LEVEL: process.env["DEBUG_API_ERRORS"] ? "error" : "silent",
    DATABASE_URL: databaseUrl,
    REDIS_URL: `redis://:${redisPassword}@127.0.0.1:${redisPort}`,
    INTERNAL_SECRET: inject("internalSecret"),
    RATE_LIMIT_MAX: "100000",
  });
  if (!parsed.ok) throw new Error(parsed.problems.join(", "));
  const infra = createInfra(parsed.env);
  const app = await createApp(parsed.env, infra);
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  closeApp = () => app.close();
}, 240_000);

afterAll(async () => {
  await closeApp?.();
  await Promise.allSettled([postgres?.stop(), redis?.stop()]);
});

/** A different visitor each time, so the limits on one address do not get in the way of what is being measured. */
let visitorCounter = 0;
const visitor = () => signInternalRequest(inject("internalSecret"), `10.9.${Math.floor(++visitorCounter / 250)}.${(visitorCounter % 250) + 1}`);

type Timed = Reply & { ms: number };
async function timed(path: string, init: Parameters<typeof call>[2] = {}): Promise<Timed> {
  const started = performance.now();
  const reply = await call(base, path, init);
  return { ...reply, ms: performance.now() - started };
}

/** Asks `/ready` until the service says yes (or fails after `seconds`). */
async function waitUntilReady(seconds: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    if ((await call(base, "/ready")).status === 200) return Date.now() - started;
    await sleep(250);
  }
  throw new Error(`service not ready again after ${seconds} s`);
}

describe("PostgreSQL restarts (acceptance check 16)", () => {
  it("works before the restart", async () => {
    expect((await call(base, "/ready")).status).toBe(200);
    expect((await login(base, "alice@example.com", passwords.user)).reply.status).toBe(200);
  });

  it("the process survives, answers fast during the outage, reports not ready, and recovers on its own", async () => {
    const restarting = postgres.restart({ timeout: 1 });
    const seen: Timed[] = [];
    let ready503 = 0;
    // Keep using the service for the whole time the database is gone and coming back.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      seen.push(await timed("/health"));
      const ready = await timed("/ready");
      if (ready.status === 503) ready503++;
      seen.push(ready);
      seen.push(await timed("/auth/login", { body: { email: "alice@example.com", password: passwords.user }, headers: visitor() }));
      await sleep(150);
    }
    await restarting;

    // /health never depends on the database; nothing ever hangs; nothing answers 5xx other than a clean 503.
    expect(seen.filter((reply) => reply.status === 500)).toEqual([]);
    expect(Math.max(...seen.map((reply) => reply.ms))).toBeLessThan(5000);
    expect(ready503).toBeGreaterThan(0);
    for (const reply of seen.filter((r) => r.status === 503)) expect(reply.headers.get("retry-after")).not.toBeNull();

    // and it is back without anybody touching the api
    await waitUntilReady(30);
    const again = await login(base, "alice@example.com", passwords.user);
    expect(again.reply.status).toBe(200);
    expect(uncaught).toEqual([]);
  }, 120_000);

  it("a database that stops answering at all (frozen, not refusing) still gives an answer within a few seconds", async () => {
    // Warm the pool first: a connection that is already open and then freezes waits for the query timeout, which is the slow case.
    await Promise.all([call(base, "/events/4/seats"), call(base, "/events/5/seats"), call(base, "/events/6/seats")]);
    docker("pause", postgres.getId());
    try {
      const login503 = await timed("/auth/login", { body: { email: "alice@example.com", password: passwords.user }, headers: visitor() });
      expect([503]).toContain(login503.status);
      expect(login503.ms).toBeLessThan(4500);
      const cold = await timed("/events/3/seats");
      expect(cold.status).toBe(503);
      expect(cold.ms, `the seat map took ${Math.round(cold.ms)} ms`).toBeLessThan(4500);
      const ready = await timed("/ready");
      expect(ready.status).toBe(503);
      expect(ready.ms).toBeLessThan(3500);
      expect((await timed("/health")).status).toBe(200);
    } finally {
      docker("unpause", postgres.getId());
    }
    await waitUntilReady(30);
    expect((await login(base, "alice@example.com", passwords.user)).reply.status).toBe(200);
    expect(uncaught).toEqual([]);
  }, 120_000);
});

describe("Redis restarts (acceptance check 16)", () => {
  it("the process survives, answers fast, reports not ready, and recovers on its own", async () => {
    const before = await login(base, "alice@example.com", passwords.user);
    const restarting = redis.restart({ timeout: 1 });
    const seen: Timed[] = [];
    let ready503 = 0;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      seen.push(await timed("/health"));
      const ready = await timed("/ready");
      if (ready.status === 503) ready503++;
      seen.push(ready);
      seen.push(await timed("/me", { cookie: before.cookie }));
      seen.push(await timed("/auth/login", { body: { email: "alice@example.com", password: passwords.user }, headers: visitor() }));
      await sleep(150);
    }
    await restarting;

    expect(seen.filter((reply) => reply.status === 500)).toEqual([]);
    expect(Math.max(...seen.map((reply) => reply.ms))).toBeLessThan(5000);
    expect(ready503).toBeGreaterThan(0);

    await waitUntilReady(30);
    const again = await login(base, "alice@example.com", passwords.user);
    expect(again.reply.status).toBe(200);
    expect((await call(base, "/me", { cookie: again.cookie })).status).toBe(200);
    expect(uncaught).toEqual([]);
  }, 120_000);

  it("a Redis that stops answering at all gives an answer within a few seconds, and sessions work again after", async () => {
    const session = await login(base, "alice@example.com", passwords.user);
    docker("pause", redis.getId());
    try {
      const me = await timed("/me", { cookie: session.cookie });
      expect(me.status).toBe(503);
      expect(me.ms).toBeLessThan(4500);
      const ready = await timed("/ready");
      expect(ready.status).toBe(503);
      expect(ready.ms).toBeLessThan(3500);
      expect((await timed("/health")).status).toBe(200);
    } finally {
      docker("unpause", redis.getId());
    }
    await waitUntilReady(30);
    expect((await call(base, "/me", { cookie: session.cookie })).status).toBe(200);
    expect(uncaught).toEqual([]);
  }, 120_000);
});

describe("a frozen Redis, the slowest requests (acceptance: no request hangs for more than a few seconds)", () => {
  it("login, registration and the seat map answer within about three seconds, not after a chain of timeouts", async () => {
    docker("pause", redis.getId());
    try {
      const mail = `frozen-${Date.now().toString(36)}@test.local`;
      const answers = await Promise.all([
        timed("/auth/login", { body: { email: "alice@example.com", password: "wrong-password-1" } }),
        timed("/auth/register", { body: { email: mail, password: "frozen-redis-password" } }),
        timed("/events/1/seats"),
        timed("/events/2"),
      ]);
      for (const [name, answer] of [["login", answers[0]], ["register", answers[1]], ["seat map", answers[2]], ["event", answers[3]]] as const) {
        expect(answer.status, name).toBeLessThan(600);
        expect(answer.ms, `${name} took ${Math.round(answer.ms)} ms`).toBeLessThan(3500);
      }
      // and every answer is a clean one: success, or a 4xx/503 in the common error shape - never an unexplained 500
      for (const answer of answers) expect([200, 201, 401, 429, 503]).toContain(answer.status);
    } finally {
      docker("unpause", redis.getId());
    }
    await waitUntilReady(30);
    expect(uncaught).toEqual([]);
  }, 120_000);
});

describe("both at once", () => {
  it("PostgreSQL and Redis restarted together: no crash, back to normal on its own", async () => {
    await Promise.all([postgres.restart({ timeout: 1 }), redis.restart({ timeout: 1 })]);
    await waitUntilReady(40);
    const again = await login(base, "bob@example.com", passwords.user);
    expect(again.reply.status).toBe(200);
    expect(uncaught).toEqual([]);
  }, 150_000);
});
