import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { inject } from "vitest";

export type TestDb = {
  url: string;
  pool: Pool;
  /** Closes the pool and drops the database. */
  close: () => Promise<void>;
};

function withDatabase(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A private copy of a template database. `seeded` has the halls, users and 100 events. */
export async function createTestDb(template: "empty" | "seeded", poolSize = 60): Promise<TestDb> {
  const adminUrl = inject("adminUrl");
  const name = `t_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template_${template}`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl, name);
  const pool = new Pool({ connectionString: url, max: poolSize });
  // When the test database is dropped, connections that are still closing report "terminating connection": that is expected.
  pool.on("error", () => undefined);
  // A connection that is being closed when its database is dropped reports the same thing on the connection itself.
  pool.on("connect", (client) => client.on("error", () => undefined));
  return {
    url,
    pool,
    close: async () => {
      await pool.end();
      const cleaner = new Client({ connectionString: adminUrl });
      await cleaner.connect();
      try {
        await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleaner.end();
      }
    },
  };
}

/** Adds `count` plain users and returns their ids. (The password hash is a placeholder: these users never log in.) */
export async function insertUsers(pool: Pool, count: number): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash)
     SELECT $2::text || g || '@test.local', 'x' FROM generate_series(1, $1::int) g
     RETURNING id`,
    [count, `u${randomUUID().slice(0, 8)}-`],
  );
  return result.rows.map((row) => row.id);
}

/** The ids of the first `count` physical seats of the hall of an event, in a fixed order. */
export async function seatIdsOf(pool: Pool, eventId: number, count: number): Promise<number[]> {
  const result = await pool.query<{ id: number }>(
    `SELECT s.id FROM seats s JOIN events e ON e.hall_id = s.hall_id
     WHERE e.id = $1 ORDER BY s.id LIMIT $2`,
    [eventId, count],
  );
  return result.rows.map((row) => row.id);
}

export type TakeResult =
  | { ok: true; holdId: string }
  | { ok: false; reason: "taken" | "limit" };

/**
 * The statement the real hold service will use (written out here so the tests exercise the DATABASE rules,
 * not the service): one transaction, one hold, rows locked in a fixed order (no deadlocks), a conditional
 * UPDATE that skips seats that are not free, and all-or-nothing: if even one seat was not won, roll back.
 * Any error other than the seat limit is re-thrown, so a deadlock or a crash fails the test.
 */
export async function takeSeats(pool: Pool, userId: string, eventId: number, seatIds: number[]): Promise<TakeResult> {
  const client = await pool.connect();
  const holdId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO holds (id, user_id, event_id, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [holdId, userId, eventId],
    );
    await client.query(
      `SELECT id FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2) ORDER BY id FOR UPDATE`,
      [eventId, seatIds],
    );
    const updated = await client.query(
      `UPDATE event_seats
       SET status = 'HELD', user_id = $1, hold_id = $2, held_until = now() + interval '10 minutes'
       WHERE event_id = $3 AND seat_id = ANY($4) AND (status = 'FREE' OR (status = 'HELD' AND held_until <= now()))`,
      [userId, holdId, eventId, seatIds],
    );
    if (updated.rowCount !== seatIds.length) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "taken" };
    }
    await client.query("COMMIT");
    return { ok: true, holdId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message === "seat_limit_exceeded") return { ok: false, reason: "limit" };
    throw error;
  } finally {
    client.release();
  }
}

/** Turns a hold into sold seats (the stub payment). */
export async function paySeats(pool: Pool, holdId: string): Promise<void> {
  await pool.query(
    `UPDATE event_seats SET status = 'SOLD', hold_id = NULL, held_until = NULL WHERE hold_id = $1 AND status = 'HELD'`,
    [holdId],
  );
  await pool.query(`UPDATE holds SET status = 'PAID' WHERE id = $1`, [holdId]);
}

/** Small deterministic random generator, so a failing run can be repeated. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
