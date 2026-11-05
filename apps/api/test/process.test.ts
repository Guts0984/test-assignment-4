import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabaseCopy } from "./helpers";

// These tests start the REAL process (src/main.ts), the way Docker starts it, and talk to it from outside.

const apiDir = fileURLToPath(new URL("..", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

type Running = { child: ChildProcess; port: number; output: () => string; exit: Promise<number | null> };
const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});

let databaseUrl: string;
beforeAll(async () => {
  databaseUrl = await createDatabaseCopy();
});

function spawnWith(port: number, extraEnv: Record<string, string | undefined>): Running {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    API_PORT: String(port),
    LOG_LEVEL: "info",
    DATABASE_URL: databaseUrl,
    REDIS_URL: inject("redisUrl"),
    INTERNAL_SECRET: inject("internalSecret"),
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: apiDir, env, stdio: ["ignore", "pipe", "pipe"] });
  started.push(child);
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  const exit = once(child, "exit").then(([code]) => code as number | null);
  return { child, port, output: () => text, exit };
}

async function waitUntilListening(running: Running, seconds = 30): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (running.output().includes("api started")) return;
    if (running.child.exitCode !== null) throw new Error(`process exited early: ${running.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`process did not start: ${running.output()}`);
}

describe("SIGTERM (acceptance check 18)", () => {
  it("an idle api leaves quickly with exit code 0", async () => {
    const port = await freePort();
    const running = spawnWith(port, {});
    await waitUntilListening(running);
    running.child.kill("SIGTERM");
    const code = await Promise.race([running.exit, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 8000))]);
    expect(code).toBe(0);
    expect(running.output()).toContain("shutting down");
  }, 60_000);

  it("a request that is half way through is finished, and only then does the process leave with code 0", async () => {
    const port = await freePort();
    const running = spawnWith(port, {});
    await waitUntilListening(running);

    // A real slow request: the headers and half of the body are sent, then the sender waits.
    const body = JSON.stringify({ email: "alice@example.com", password: "not the right password" });
    const cut = Math.floor(body.length / 2);
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.on("data", (chunk) => (response += chunk.toString()));
    await once(socket, "connect");
    socket.write(`POST /auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, cut)}`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    running.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 800));
    // The request is still being served, so the process must still be alive (it did not cut the request off) ...
    expect(running.child.exitCode).toBeNull();
    expect(response).toBe("");

    // ... and a new connection is no longer accepted.
    const refused = await new Promise<boolean>((resolve) => {
      const probe = connect(port, "127.0.0.1");
      probe.on("error", () => resolve(true));
      probe.on("connect", () => {
        probe.destroy();
        resolve(false);
      });
    });
    expect(refused).toBe(true);

    // The slow sender finishes the request. It gets a full, proper answer ...
    socket.write(body.slice(cut));
    await once(socket, "close").catch(() => undefined);
    expect(response).toMatch(/^HTTP\/1\.1 401 /);
    expect(response).toContain("INVALID_CREDENTIALS");

    // ... and then the process leaves with code 0.
    expect(await running.exit).toBe(0);
  }, 60_000);
});

describe("configuration at startup", () => {
  const cases: Array<[string, Record<string, string | undefined>, RegExp]> = [
    ["no internal secret", { INTERNAL_SECRET: undefined }, /INTERNAL_SECRET/],
    ["a short internal secret", { INTERNAL_SECRET: "too-short" }, /INTERNAL_SECRET.*32/],
    ["no database address", { DATABASE_URL: undefined }, /DATABASE_URL/],
    ["a database address that is not a postgresql address", { DATABASE_URL: "mysql://x" }, /DATABASE_URL/],
    ["no Redis address", { REDIS_URL: undefined }, /REDIS_URL/],
    ["a port that is not a number", { API_PORT: "abc" }, /API_PORT/],
    ["an unknown log level", { LOG_LEVEL: "loud" }, /LOG_LEVEL/],
  ];

  it.each(cases)("%s: the process refuses to start (exit 1) and says what is wrong", async (_name, change, message) => {
    const running = spawnWith(0, change);
    expect(await running.exit).toBe(1);
    expect(running.output()).toContain("cannot start");
    expect(running.output()).toMatch(message);
  }, 30_000);

  it("the error message does not print the secrets that were given", async () => {
    const running = spawnWith(0, { INTERNAL_SECRET: "short-but-secret-value", DATABASE_URL: "mysql://user:hunter2@host/db" });
    await running.exit;
    expect(running.output()).not.toContain("short-but-secret-value");
    expect(running.output()).not.toContain("hunter2");
  }, 30_000);
});
