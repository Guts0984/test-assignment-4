import { createHash } from "node:crypto";
import { Prisma } from "@app/db";
import { ErrorCode } from "@app/shared";
import { AppError, renderError } from "../http/errors";
import type { Infra } from "../infra/infra";

export type StoredResponse = { status: number; body: unknown };
export type IdempotentResult = StoredResponse & { replayed: boolean };

/** Hash of "what was asked": the same key with another request is a mistake the client must hear about. */
export function requestHash(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

const WAIT_FOR_FIRST_REQUEST_MS = 4000;
/** A "running" note older than this belongs to a request that died half way (its transaction was rolled back). */
const ABANDONED_AFTER_MS = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Do this once, however many times the client sends it" for requests that carry an Idempotency-Key.
 *
 * The first request with a key writes a note (user + key + hash of the request) and does the work. The unique index on
 * (user, key) decides who is first, even when 50 identical requests arrive at the same moment on two instances.
 * Everybody else gets the SAME answer the first one got (status and body); if the first one is still working, they wait for it.
 * Answers that are final (success, or a refusal like "seat taken") are stored; a failure of ours (5xx, database down)
 * is not, so a retry with the same key can try again.
 */
export async function runOnce(
  infra: Infra,
  userId: string,
  key: string,
  hash: string,
  work: () => Promise<StoredResponse>,
): Promise<IdempotentResult> {
  const { db } = infra;
  for (let attempt = 0; attempt < 3; attempt++) {
    const created = await db.idempotencyKey.createMany({ data: { userId, key, requestHash: hash }, skipDuplicates: true });
    if (created.count === 1) return runFirst(infra, userId, key, work);

    const started = Date.now();
    for (;;) {
      const note = await db.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
      if (!note) break; // the first attempt failed and removed its note: try to be the first ourselves
      if (note.requestHash !== hash) {
        throw new AppError(422, ErrorCode.IDEMPOTENCY_KEY_REUSED, "This Idempotency-Key was already used for a different request.");
      }
      if (note.responseStatus !== null) return { status: note.responseStatus, body: note.responseBody, replayed: true };
      if (Date.now() - note.createdAt.getTime() > ABANDONED_AFTER_MS) {
        await db.idempotencyKey.deleteMany({ where: { id: note.id, responseStatus: null } });
        break;
      }
      if (Date.now() - started > WAIT_FOR_FIRST_REQUEST_MS) {
        throw new AppError(409, ErrorCode.REQUEST_IN_PROGRESS, "The first request with this key is still running. Try again in a moment.", undefined, { "Retry-After": "1" });
      }
      await sleep(40);
    }
  }
  throw new AppError(409, ErrorCode.REQUEST_IN_PROGRESS, "The first request with this key is still running. Try again in a moment.", undefined, { "Retry-After": "1" });
}

async function runFirst(infra: Infra, userId: string, key: string, work: () => Promise<StoredResponse>): Promise<IdempotentResult> {
  const { db } = infra;
  const where = { userId_key: { userId, key } };
  try {
    const result = await work();
    await db.idempotencyKey.update({ where, data: { responseStatus: result.status, responseBody: result.body as Prisma.InputJsonValue } });
    return { ...result, replayed: false };
  } catch (error) {
    const rendered = renderError(error);
    if (rendered.status < 500 && rendered.status !== 429) {
      // A final refusal: remember it, so the same key always gets the same answer.
      await db.idempotencyKey.update({ where, data: { responseStatus: rendered.status, responseBody: rendered.body as Prisma.InputJsonValue } }).catch(() => undefined);
    } else {
      // Our fault or a temporary problem: forget the key so that a retry can run for real.
      await db.idempotencyKey.deleteMany({ where: { userId, key, responseStatus: null } }).catch(() => undefined);
    }
    throw error;
  }
}
