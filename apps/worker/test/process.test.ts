import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterEach, beforeAll, describe, expect, inject, it } from "vitest";

// The REAL worker process, started the way Docker starts it.
const workerDir = fileURLToPath(new URL("..", import.meta.url));
const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});

let databaseUrl: string;
beforeAll(async () => {
  const adminUrl = inject("pgAdminUrl");
  const name = `p_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template_seeded`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  databaseUrl = url.toString();
});

function spawnWorker(change: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    LOG_LEVEL: "info",
    HEALTH_PORT: "0",
    DATABASE_URL: databaseUrl,
    REDIS_URL: inject("redisUrl"),
    INTERNAL_SECRET: inject("internalSecret"),
    OUTBOX_EVERY_MS: "200",
    REVALIDATE_AGAIN_AFTER_MS: "3600000",
    REVALIDATE_RETRY_MS: "10000",
  };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: workerDir, env, stdio: ["ignore", "pipe", "pipe"] });
  started.push(child);
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  return { child, output: () => text, exit: once(child, "exit").then(([code]) => code as number | null) };
}
async function waitFor(what: string, probe: () => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("SIGTERM (acceptance check 18)", () => {
  it("an idle worker leaves with code 0", async () => {
    const worker = spawnWorker();
    await waitFor("worker started", () => worker.output().includes("worker started"));
    worker.child.kill("SIGTERM");
    expect(await Promise.race([worker.exit, new Promise((resolve) => setTimeout(() => resolve("still running"), 10_000))])).toBe(0);
  }, 60_000);

  it("a job that is running is finished first, then the worker leaves with code 0", async () => {
    // A web app that answers slowly: the worker is in the middle of its call when the signal comes.
    let answeredAt = 0;
    let receivedAt = 0;
    const slowWeb = createServer((req, res) => {
      receivedAt = Date.now();
      req.resume();
      setTimeout(() => {
        answeredAt = Date.now();
        res.writeHead(200).end("{}");
      }, 1500);
    });
    await new Promise<void>((resolve) => slowWeb.listen(0, "127.0.0.1", resolve));
    const address = slowWeb.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const worker = spawnWorker({ WEB_URL: `http://127.0.0.1:${port}` });
    await waitFor("worker started", () => worker.output().includes("worker started"));
    const sql = new Client({ connectionString: databaseUrl });
    await sql.connect();
    await sql.query(`UPDATE events SET title = 'Slow call' WHERE id = 3`);
    await sql.end();
    await waitFor("the call reached the web app", () => receivedAt > 0);

    worker.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(worker.child.exitCode).toBeNull(); // still waiting for the call to finish
    expect(await worker.exit).toBe(0);
    expect(answeredAt).toBeGreaterThan(0); // the call was allowed to finish before the worker left
    expect(answeredAt).toBeLessThanOrEqual(Date.now());
    await new Promise<void>((resolve) => slowWeb.close(() => resolve()));
  }, 60_000);
});

describe("configuration at startup", () => {
  const cases: Array<[string, Record<string, string | undefined>, RegExp]> = [
    ["no internal secret", { INTERNAL_SECRET: undefined }, /INTERNAL_SECRET/],
    ["a short internal secret", { INTERNAL_SECRET: "short" }, /INTERNAL_SECRET.*32/],
    ["no database address", { DATABASE_URL: undefined }, /DATABASE_URL/],
    ["no Redis address", { REDIS_URL: undefined }, /REDIS_URL/],
    ["a web address that is not http", { WEB_URL: "ftp://web" }, /WEB_URL/],
  ];
  it.each(cases)("%s: refuses to start (exit 1) and says what is wrong", async (_name, change, message) => {
    const worker = spawnWorker(change);
    expect(await worker.exit).toBe(1);
    expect(worker.output()).toContain("cannot start");
    expect(worker.output()).toMatch(message);
  }, 30_000);
});
