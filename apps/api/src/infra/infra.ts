import { createDb, type Db } from "@app/db";
import { Redis } from "ioredis";
import type { Env } from "../env";
import { createLogger, type Logger } from "./logger";

/**
 * The connections every part of the api shares: PostgreSQL, Redis and the logger.
 *
 * Both connections are built to SURVIVE restarts of the servers behind them and never to hang:
 * - Redis: connecting gives up after 3 s, a command after 2 s; commands fail at once while the connection is down
 *   (no waiting queue that would hold requests); the client reconnects by itself, waiting a little longer each time.
 * - PostgreSQL: see createDb (3 s to get a connection, 5 s per query, broken idle connections are logged, not thrown).
 * - Errors of both are only logged: an unhandled 'error' event would stop the process.
 */
export class Infra {
  constructor(
    readonly env: Env,
    readonly logger: Logger,
    readonly redis: Redis,
    readonly db: Db,
  ) {}

  /** Called by Nest when the application closes. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.redis.quit().catch(() => this.redis.disconnect()), this.db.$disconnect()]);
  }
}

export function createInfra(env: Env, logger: Logger = createLogger(env.LOG_LEVEL), hooks: { onQuery?: (sql: string) => void } = {}): Infra {
  const redis = new Redis(env.REDIS_URL, {
    connectTimeout: 3000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    reconnectOnError: () => true,
  });
  failFastWhileRedisIsFrozen(redis);
  redis.on("error", (error) => logger.warn({ err: error.message }, "redis error"));
  redis.on("reconnecting", () => logger.warn("redis reconnecting"));
  redis.on("ready", () => logger.info("redis ready"));

  const db = createDb(env.DATABASE_URL, {
    // No single query waits longer than 2.5 s (3.5 s on the client side, for a database that has frozen and never answers).
    statementTimeoutMs: 2500,
    onError: (error) => logger.warn({ err: error.message }, "postgres connection error"),
    ...(hooks.onQuery ? { onQuery: hooks.onQuery } : {}),
  });
  return new Infra(env, logger, redis, db);
}

/**
 * Waits (at most `ms`) for Redis to be connected. Without this the first requests after a start would find the
 * connection not ready yet and, because commands fail at once while it is down, skip the rate limit and fail to read sessions.
 * If Redis really is down the app still starts (and answers 503 / not ready until it comes back).
 */
export async function waitForRedis(redis: Redis, ms = 5000): Promise<void> {
  if (redis.status === "ready") return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    redis.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Rejects if `work` takes longer than `ms`. Used where a hanging dependency must not hold a request. */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A frozen Redis (it accepts the connection but never answers) makes EVERY command wait for its own timeout. One request makes
 * several Redis calls one after another (limits, failure counters, the session ...), so it would hang for 4 x 2 s or more.
 * So: once one command has timed out, the commands that follow fail at once for a short moment, and then one of them tries again.
 * A request then waits for one timeout, not for a chain of them. (A refused or closed connection is not affected: it already fails fast.)
 */
export function failFastWhileRedisIsFrozen(redis: Redis, openForMs = 1500): void {
  let openUntil = 0;
  const send = redis.sendCommand.bind(redis) as (command: unknown, stream?: unknown) => unknown;
  (redis as unknown as { sendCommand: typeof send }).sendCommand = (command, stream) => {
    if (Date.now() < openUntil) return Promise.reject(new Error("Command timed out: redis is not answering (failing fast)"));
    const result = send(command, stream);
    if (result instanceof Promise) {
      result.catch((error: unknown) => {
        if (error instanceof Error && /timed out/i.test(error.message)) openUntil = Date.now() + openForMs;
      });
    }
    return result;
  };
}
