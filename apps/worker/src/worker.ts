import http from "node:http";
import { createDb } from "@app/db";
import { Emitter } from "@socket.io/redis-emitter";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Env } from "./env";
import { callRevalidate, cleanIdempotencyKeys, expireHolds, relayOutbox, type JobContext, type RevalidateJob } from "./jobs";
import { createLogger, type Logger } from "./logger";

export type RunningWorker = {
  ctx: JobContext;
  healthPort: number;
  /** Lets running jobs finish, then closes every connection. */
  close: () => Promise<void>;
};

/**
 * Starts everything the worker does:
 * - a "maintenance" queue with three jobs that repeat on a schedule kept in Redis (so a restart loses nothing and
 *   several workers do not double the work): release expired holds, relay event changes, tidy old notes;
 * - a "revalidate" queue: signed calls to the web app, retried with growing pauses while it is unavailable.
 * All state lives in PostgreSQL and Redis, so the worker itself can be stopped and started at any moment.
 */
export async function startWorker(env: Env, logger: Logger = createLogger(env.LOG_LEVEL)): Promise<RunningWorker> {
  // BullMQ's blocking commands need "no retry limit"; connection trouble is only logged, the clients reconnect by themselves.
  const makeRedis = (): Redis => {
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: (attempt) => Math.min(attempt * 200, 2000) });
    redis.on("error", (error) => logger.warn({ err: error.message }, "redis error"));
    return redis;
  };
  const connections = [makeRedis(), makeRedis(), makeRedis(), makeRedis()] as const;
  const [queueConnection, maintenanceConnection, revalidateConnection, dataConnection] = connections;

  const db = createDb(env.DATABASE_URL, { onError: (error) => logger.warn({ err: error.message }, "postgres connection error") });
  const emitter = new Emitter(dataConnection);

  const maintenanceQueue = new Queue("maintenance", { connection: queueConnection });
  const revalidateQueue = new Queue<RevalidateJob>("revalidate", {
    connection: queueConnection,
    defaultJobOptions: {
      // Up to 12 tries, pausing 1 s, 2 s, 4 s ... (capped by BullMQ's own limit) while the web app is unavailable.
      attempts: 12,
      backoff: { type: "exponential", delay: env.REVALIDATE_RETRY_MS },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400 },
    },
  });

  const ctx: JobContext = { db, redis: dataConnection, emitter, revalidateQueue, logger, secret: env.INTERNAL_SECRET, webUrl: env.WEB_URL, revalidateAgainAfterMs: env.REVALIDATE_AGAIN_AFTER_MS };

  // Schedules are stored in Redis under a fixed name: starting twice, or starting several workers, keeps ONE schedule.
  await maintenanceQueue.upsertJobScheduler("expire-holds", { every: env.EXPIRE_EVERY_MS }, { name: "expire-holds" });
  await maintenanceQueue.upsertJobScheduler("relay-outbox", { every: env.OUTBOX_EVERY_MS }, { name: "relay-outbox" });
  await maintenanceQueue.upsertJobScheduler("clean-old-notes", { every: 3_600_000 }, { name: "clean-old-notes" });

  const maintenanceWorker = new Worker(
    "maintenance",
    async (job) => {
      switch (job.name) {
        case "expire-holds":
          return expireHolds(ctx);
        case "relay-outbox":
          return relayOutbox(ctx);
        case "clean-old-notes":
          return cleanIdempotencyKeys(ctx);
        default:
          throw new Error(`unknown job ${job.name}`);
      }
    },
    { connection: maintenanceConnection, concurrency: 1 },
  );
  const revalidateWorker = new Worker<RevalidateJob>("revalidate", (job) => callRevalidate(ctx, job.data), { connection: revalidateConnection, concurrency: 5 });
  for (const worker of [maintenanceWorker, revalidateWorker]) {
    worker.on("error", (error) => logger.warn({ err: error.message }, "queue error"));
    worker.on("failed", (job, error) => logger.warn({ job: job?.name, attempt: job?.attemptsMade, err: error.message }, "job failed"));
  }

  // For Docker's health check.
  const health = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => health.listen(env.HEALTH_PORT, resolve));
  const address = health.address();
  const healthPort = typeof address === "object" && address ? address.port : env.HEALTH_PORT;

  return {
    ctx,
    healthPort,
    close: async () => {
      // close() waits for the job that is running right now, and starts no new one.
      await Promise.allSettled([maintenanceWorker.close(), revalidateWorker.close()]);
      await Promise.allSettled([maintenanceQueue.close(), revalidateQueue.close()]);
      await new Promise<void>((resolve) => health.close(() => resolve()));
      await db.$disconnect().catch(() => undefined);
      for (const connection of connections) connection.disconnect();
    },
  };
}
