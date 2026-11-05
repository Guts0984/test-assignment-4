import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client } from "pg";
import { Redis } from "ioredis";
import { inject } from "vitest";
import { createApp } from "../src/app";
import { parseEnv, type Env } from "../src/env";
import { createInfra, type Infra } from "../src/infra/infra";

export type TestApp = {
  base: string;
  app: NestExpressApplication;
  infra: Infra;
  env: Env;
  databaseUrl: string;
  close: () => Promise<void>;
};

function withDatabase(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A private copy of the seeded database (admin, alice and bob exist). */
export async function createDatabaseCopy(): Promise<string> {
  const adminUrl = inject("pgAdminUrl");
  const name = `t_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template_seeded`);
  } finally {
    await admin.end();
  }
  return withDatabase(adminUrl, name);
}

export async function flushRedis(): Promise<void> {
  const redis = new Redis(inject("redisUrl"));
  try {
    await redis.flushall();
  } finally {
    redis.disconnect();
  }
}

export function testEnv(overrides: Record<string, string> = {}, databaseUrl: string = inject("pgAdminUrl")): Env {
  const result = parseEnv({
    API_PORT: "0",
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseUrl,
    REDIS_URL: inject("redisUrl"),
    INTERNAL_SECRET: inject("internalSecret"),
    ...overrides,
  });
  if (!result.ok) throw new Error(`bad test env: ${result.problems.join(", ")}`);
  return result.env;
}

/**
 * Starts the real application (all middleware, the same factory as the process) on a free port, with its own copy of the
 * seeded database unless `databaseUrl` is given (two instances of one "deployment" share a database and a Redis).
 */
export async function startApp(options: { env?: Record<string, string>; databaseUrl?: string; flush?: boolean; onQuery?: (sql: string) => unknown } = {}): Promise<TestApp> {
  if (options.flush !== false && !options.databaseUrl) await flushRedis();
  const databaseUrl = options.databaseUrl ?? (await createDatabaseCopy());
  const env = testEnv(options.env, databaseUrl);
  const { onQuery } = options;
  const infra = createInfra(env, undefined, onQuery ? { onQuery: (sql) => void onQuery(sql) } : {});
  const app = await createApp(env, infra);
  await app.listen(0, "127.0.0.1");
  return {
    base: await app.getUrl(),
    app,
    infra,
    env,
    databaseUrl,
    close: () => app.close(),
  };
}

export type Reply = { status: number; headers: Headers; body: unknown; text: string };

/** One HTTP call; never throws on a 4xx/5xx; the body is parsed when it is JSON. */
export async function call(base: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; rawBody?: string; cookie?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie) headers["cookie"] = init.cookie;
  let body: string | undefined = init.rawBody;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await fetch(`${base}${path}`, { method: init.method ?? (body === undefined ? "GET" : "POST"), headers, ...(body === undefined ? {} : { body }) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON; keep the text
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

/** Logs in and returns the cookie to send with later calls ("sid=..."). */
export async function login(base: string, email: string, password: string, headers: Record<string, string> = {}): Promise<{ cookie: string; reply: Reply }> {
  const reply = await call(base, "/auth/login", { body: { email, password }, headers });
  const setCookie = reply.headers.get("set-cookie") ?? "";
  return { cookie: setCookie.split(";")[0] ?? "", reply };
}
