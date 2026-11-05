import type { Db } from "@app/db";
import { SOCKET_EVENTS, seatRoom, type SeatsChanged } from "@app/shared";
import { signInternalRequest } from "@app/shared/internal";
import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { Emitter } from "@socket.io/redis-emitter";
import type { Logger } from "./logger";

/** What the jobs need from the outside world. */
export type JobContext = {
  db: Db;
  redis: Redis;
  /** Sends messages to everybody watching a hall, whichever api instance they are connected to. */
  emitter: Emitter;
  revalidateQueue: Queue<RevalidateJob>;
  logger: Logger;
  secret: string;
  webUrl: string;
  revalidateAgainAfterMs: number;
};

export type RevalidateJob = { eventId: number; version: number };

const GENERATION_KEY = "gen:events";

// ----------------------------------------------------------------------------------------------------------
// 1. Hold expiry
// ----------------------------------------------------------------------------------------------------------

/**
 * Releases the seats of holds whose time is up, and tells everybody watching those halls.
 *
 * Safe to run at any moment, by any number of workers, any number of times:
 * - one statement marks ACTIVE holds that are past their time as EXPIRED and frees their still-held seats; a second
 *   worker running at the same moment waits for the row locks and then finds nothing left to do;
 * - a seat that was already taken over by another user's hold is not touched (the match is on the hold id);
 * - paying locks the same hold row, so "paid" and "expired" can never both happen.
 * Nothing is lost if the worker is stopped in the middle: the change is one transaction, the announcement follows it,
 * and a missed announcement only costs a watcher a refresh (they ask for the whole map again on reconnect).
 */
export async function expireHolds(ctx: JobContext): Promise<number> {
  const freed = await ctx.db.$queryRaw<{ event_id: number; seat_id: number }[]>`
    WITH expired AS (
      UPDATE holds SET status = 'EXPIRED'
      WHERE status = 'ACTIVE' AND expires_at <= now()
      RETURNING id
    )
    UPDATE event_seats es
    SET status = 'FREE', user_id = NULL, hold_id = NULL, held_until = NULL
    FROM expired
    WHERE es.hold_id = expired.id AND es.status = 'HELD'
    RETURNING es.event_id, es.seat_id`;

  // Seats can also be left over from a hold that is no longer ACTIVE but whose seats were not freed (should not happen; cheap to tidy).
  const leftovers = await ctx.db.$queryRaw<{ event_id: number; seat_id: number }[]>`
    UPDATE event_seats SET status = 'FREE', user_id = NULL, hold_id = NULL, held_until = NULL
    WHERE status = 'HELD' AND held_until <= now() - interval '30 seconds'
    RETURNING event_id, seat_id`;

  const byEvent = new Map<number, number[]>();
  for (const row of [...freed, ...leftovers]) byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row.seat_id]);
  for (const [eventId, seatIds] of byEvent) {
    const payload: SeatsChanged = { eventId, changes: seatIds.map((seatId) => ({ seatId, status: "free" as const })) };
    ctx.emitter.to(seatRoom(eventId)).emit(SOCKET_EVENTS.seatsChanged, payload);
  }
  if (freed.length + leftovers.length > 0) ctx.logger.info({ seats: freed.length + leftovers.length, events: byEvent.size }, "expired holds released");
  return freed.length + leftovers.length;
}

// ----------------------------------------------------------------------------------------------------------
// 2. Outbox: "an event changed"
// ----------------------------------------------------------------------------------------------------------

/**
 * Reads the notes the database wrote when an event changed (whoever changed it - the api, or a person with an SQL console),
 * and for each batch:
 *   1. raises the cache generation in Redis, so the api's caches drop their copies,
 *   2. queues a call that asks the web app to forget its cached pages - now, and once more a few seconds later.
 * A note is marked done only after both are queued. If the worker stops in between, the note is read again; the queued
 * jobs have fixed ids (event + version + which call), so queuing them twice makes no duplicates.
 * `FOR UPDATE SKIP LOCKED` lets two workers share the notes without taking the same one.
 */
export async function relayOutbox(ctx: JobContext): Promise<number> {
  return ctx.db.$transaction(
    async (tx) => {
      const notes = await tx.$queryRaw<{ id: bigint; payload: { eventId: number; version: number } }[]>`
        SELECT id, payload FROM outbox WHERE processed_at IS NULL AND type = 'event.changed'
        ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`;
      if (notes.length === 0) return 0;

      await ctx.redis.incr(GENERATION_KEY);
      for (const note of notes) {
        const { eventId, version } = note.payload;
        const data: RevalidateJob = { eventId, version };
        await ctx.revalidateQueue.add("revalidate", data, { jobId: `revalidate-${eventId}-${version}-now-${note.id}` });
        await ctx.revalidateQueue.add("revalidate", data, { jobId: `revalidate-${eventId}-${version}-again-${note.id}`, delay: ctx.revalidateAgainAfterMs });
      }
      const ids = notes.map((note) => note.id);
      await tx.$executeRaw`UPDATE outbox SET processed_at = now() WHERE id = ANY(${ids}::bigint[])`;
      ctx.logger.info({ notes: notes.length }, "event changes relayed");
      return notes.length;
    },
    { timeout: 15_000, maxWait: 5_000 },
  );
}

// ----------------------------------------------------------------------------------------------------------
// 3. Telling the web app
// ----------------------------------------------------------------------------------------------------------

/**
 * Asks the web app to forget its cached pages for an event. The request is signed with the shared secret, so only
 * we can make it. If the web app is down or answers with an error this throws, and BullMQ tries again later with
 * growing pauses (see the queue options in main.ts).
 */
export async function callRevalidate(ctx: Pick<JobContext, "secret" | "webUrl" | "logger">, job: RevalidateJob): Promise<void> {
  const response = await fetch(`${ctx.webUrl}/internal/revalidate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...signInternalRequest(ctx.secret) },
    body: JSON.stringify({ tags: [`event:${job.eventId}`, "events"] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`web answered ${response.status}`);
  ctx.logger.info({ eventId: job.eventId, version: job.version }, "web cache cleared");
}

// ----------------------------------------------------------------------------------------------------------
// 4. Tidying
// ----------------------------------------------------------------------------------------------------------

/** Idempotency notes older than a day are no longer needed. */
export async function cleanIdempotencyKeys(ctx: JobContext): Promise<number> {
  const removed = await ctx.db.$executeRaw`DELETE FROM idempotency_keys WHERE created_at < now() - interval '1 day'`;
  const outbox = await ctx.db.$executeRaw`DELETE FROM outbox WHERE processed_at IS NOT NULL AND processed_at < now() - interval '7 days'`;
  return removed + outbox;
}
