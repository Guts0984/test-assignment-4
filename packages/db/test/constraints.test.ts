import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, insertUsers, paySeats, seatIdsOf, takeSeats, type TestDb } from "./helpers";

// Bad data must be refused by the DATABASE itself. Each "refused" test also checks that nothing was changed,
// and each rule has a "good value is accepted" partner, so a rule that refuses everything cannot pass.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb("seeded");
});
afterAll(async () => {
  await db.close();
});

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params);
  return result.rows[0]?.n ?? -1;
}

describe("event_seats: the status columns must agree with each other", () => {
  async function setup() {
    const eventId = 1;
    const [seatId] = await seatIdsOf(db.pool, eventId, 1);
    const [userId] = await insertUsers(db.pool, 1);
    const hold = await db.pool.query<{ id: string }>(
      `INSERT INTO holds (user_id, event_id, expires_at) VALUES ($1, $2, now() + interval '10 minutes') RETURNING id`,
      [userId, eventId],
    );
    return { eventId, seatId: seatId as number, userId: userId as string, holdId: hold.rows[0]?.id as string };
  }

  const bad: Array<[string, string]> = [
    ["FREE but has a user", "status = 'FREE', user_id = $1"],
    ["FREE but has a hold", "status = 'FREE', hold_id = $2"],
    ["FREE but has a deadline", "status = 'FREE', held_until = now() + interval '1 minute'"],
    ["HELD without a user", "status = 'HELD', hold_id = $2, held_until = now() + interval '1 minute'"],
    ["HELD without a hold", "status = 'HELD', user_id = $1, held_until = now() + interval '1 minute'"],
    ["HELD without a deadline", "status = 'HELD', user_id = $1, hold_id = $2"],
    ["SOLD without a user", "status = 'SOLD'"],
    ["SOLD still carrying a deadline", "status = 'SOLD', user_id = $1, held_until = now() + interval '1 minute'"],
    ["SOLD still carrying a hold", "status = 'SOLD', user_id = $1, hold_id = $2"],
  ];

  it.each(bad)("refuses a seat that is %s", async (_name, set) => {
    const { eventId, seatId, userId, holdId } = await setup();
    await expect(
      db.pool.query(`UPDATE event_seats SET ${set} WHERE event_id = $3 AND seat_id = $4 AND $1::uuid IS NOT NULL AND $2::uuid IS NOT NULL`, [userId, holdId, eventId, seatId]),
    ).rejects.toThrow(/event_seats_status_columns_consistent/);
    const row = await db.pool.query(`SELECT status, user_id, hold_id, held_until FROM event_seats WHERE event_id = $1 AND seat_id = $2`, [eventId, seatId]);
    expect(row.rows[0]).toEqual({ status: "FREE", user_id: null, hold_id: null, held_until: null });
  });

  it("accepts the three consistent shapes (so the rule is not simply refusing everything)", async () => {
    const { eventId, seatId, userId, holdId } = await setup();
    const update = (set: string) =>
      db.pool.query(`UPDATE event_seats SET ${set} WHERE event_id = $3 AND seat_id = $4 AND $1::uuid IS NOT NULL AND $2::uuid IS NOT NULL`, [userId, holdId, eventId, seatId]);
    await expect(update("status = 'HELD', user_id = $1, hold_id = $2, held_until = now() + interval '1 minute'")).resolves.toBeDefined();
    await expect(update("status = 'SOLD', user_id = $1, hold_id = NULL, held_until = NULL")).resolves.toBeDefined();
  });
});

describe("event_seats: a seat belongs to the hall of its event", () => {
  it("refuses a seat of another hall, accepts a seat of the right hall", async () => {
    const event = await db.pool.query<{ id: number; hall_id: number }>(
      `INSERT INTO events (title, description, city, starts_at, hall_id) VALUES ('Hall test', '', 'Chicago', now() + interval '3 days', 1) RETURNING id, hall_id`,
    );
    const eventId = event.rows[0]?.id as number;
    const otherHall = await db.pool.query<{ id: number }>(`SELECT id FROM seats WHERE hall_id = 2 LIMIT 1`);
    const ownHall = await db.pool.query<{ id: number }>(`SELECT id FROM seats WHERE hall_id = 1 LIMIT 1`);

    await expect(
      db.pool.query(`INSERT INTO event_seats (event_id, seat_id) VALUES ($1, $2)`, [eventId, otherHall.rows[0]?.id]),
    ).rejects.toThrow("seat_not_in_event_hall");
    expect(await count(`SELECT 1 FROM event_seats WHERE event_id = $1`, [eventId])).toBe(0);

    await db.pool.query(`INSERT INTO event_seats (event_id, seat_id) VALUES ($1, $2)`, [eventId, ownHall.rows[0]?.id]);
    expect(await count(`SELECT 1 FROM event_seats WHERE event_id = $1`, [eventId])).toBe(1);
  });

  it("the same seat cannot be added to the same event twice", async () => {
    const [seatId] = await seatIdsOf(db.pool, 5, 1);
    await expect(db.pool.query(`INSERT INTO event_seats (event_id, seat_id) VALUES (5, $1)`, [seatId])).rejects.toThrow(/event_seats_event_id_seat_id_key/);
  });
});

describe("plain value checks", () => {
  const insertSeat = (row: string, number: number) =>
    db.pool.query(`INSERT INTO seats (hall_id, "row", number) VALUES (1, $1, $2)`, [row, number]);
  const insertEvent = (title: string, description = "", version = 1) =>
    db.pool.query(
      `INSERT INTO events (title, description, city, starts_at, hall_id, version) VALUES ($1, $2, 'Miami', now() + interval '2 days', 1, $3)`,
      [title, description, version],
    );

  it("seats: row label must not be empty, number must be positive, a place exists once per hall", async () => {
    await expect(insertSeat("", 1)).rejects.toThrow(/seats_row_not_empty/);
    await expect(insertSeat("   ", 1)).rejects.toThrow(/seats_row_not_empty/);
    await expect(insertSeat("Z", 0)).rejects.toThrow(/seats_number_positive/);
    await expect(insertSeat("Z", -3)).rejects.toThrow(/seats_number_positive/);
    await expect(insertSeat("A", 1)).rejects.toThrow(/seats_hall_id_row_number_key/);
    await expect(insertSeat("Z", 1)).resolves.toBeDefined();
  });

  it("events: title 1..200 characters (spaces do not count as a title), description at most 5000", async () => {
    await expect(insertEvent("")).rejects.toThrow(/events_title_length/);
    await expect(insertEvent("     ")).rejects.toThrow(/events_title_length/);
    await expect(insertEvent("x".repeat(201))).rejects.toThrow(/events_title_length/);
    await expect(insertEvent("x".repeat(200))).resolves.toBeDefined();
    await expect(insertEvent("Emoji 🎭", "")).resolves.toBeDefined();
    await expect(insertEvent("Ok", "d".repeat(5001))).rejects.toThrow(/events_description_length/);
    await expect(insertEvent("Ok", "d".repeat(5000))).resolves.toBeDefined();
  });

  it("events: a version below 1 is refused", async () => {
    await expect(insertEvent("Versioned", "", 0)).rejects.toThrow(/events_version_positive/);
    await expect(insertEvent("Versioned", "", -1)).rejects.toThrow(/events_version_positive/);
  });

  it("holds: a hold must end after it was created", async () => {
    const [userId] = await insertUsers(db.pool, 1);
    const insertHold = (expiry: string) =>
      db.pool.query(`INSERT INTO holds (user_id, event_id, created_at, expires_at) VALUES ($1, 1, now(), ${expiry})`, [userId]);
    await expect(insertHold("now()")).rejects.toThrow(/holds_expires_after_creation/);
    await expect(insertHold("now() - interval '1 minute'")).rejects.toThrow(/holds_expires_after_creation/);
    await expect(insertHold("now() + interval '1 minute'")).resolves.toBeDefined();
  });

  it("seats cannot point at a hold, user or event that does not exist", async () => {
    const [seatId] = await seatIdsOf(db.pool, 6, 1);
    const [userId] = await insertUsers(db.pool, 1);
    await expect(
      db.pool.query(
        `UPDATE event_seats SET status = 'HELD', user_id = $1, hold_id = $2, held_until = now() + interval '1 minute' WHERE event_id = 6 AND seat_id = $3`,
        [userId, randomUUID(), seatId],
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(db.pool.query(`INSERT INTO event_seats (event_id, seat_id) VALUES (999999, $1)`, [seatId])).rejects.toThrow(/foreign key|seat_not_in_event_hall/);
  });
});

describe("a seat can be sold only once, even if the seat state is wrong", () => {
  async function paidSeat(eventId: number) {
    const [seatId] = await seatIdsOf(db.pool, eventId, 1);
    const [userId] = await insertUsers(db.pool, 1);
    const taken = await takeSeats(db.pool, userId as string, eventId, [seatId as number]);
    if (!taken.ok) throw new Error("setup failed");
    await paySeats(db.pool, taken.holdId);
    const order = await db.pool.query<{ id: string }>(`INSERT INTO orders (user_id, event_id, hold_id) VALUES ($1, $2, $3) RETURNING id`, [userId, eventId, taken.holdId]);
    return { eventId, seatId: seatId as number, userId: userId as string, orderId: order.rows[0]?.id as string, holdId: taken.holdId };
  }

  it("the same seat of an event cannot be on two order lines (the second, independent guard)", async () => {
    const { eventId, seatId, userId, orderId } = await paidSeat(10);
    await db.pool.query(`INSERT INTO order_items (order_id, event_id, seat_id) VALUES ($1, $2, $3)`, [orderId, eventId, seatId]);

    // again in the same order
    await expect(db.pool.query(`INSERT INTO order_items (order_id, event_id, seat_id) VALUES ($1, $2, $3)`, [orderId, eventId, seatId])).rejects.toThrow(/order_items_event_id_seat_id_key/);

    // and in a different order of another hold
    const otherHold = await db.pool.query<{ id: string }>(`INSERT INTO holds (user_id, event_id, expires_at) VALUES ($1, $2, now() + interval '1 minute') RETURNING id`, [userId, eventId]);
    const otherOrder = await db.pool.query<{ id: string }>(`INSERT INTO orders (user_id, event_id, hold_id) VALUES ($1, $2, $3) RETURNING id`, [userId, eventId, otherHold.rows[0]?.id]);
    await expect(
      db.pool.query(`INSERT INTO order_items (order_id, event_id, seat_id) VALUES ($1, $2, $3)`, [otherOrder.rows[0]?.id, eventId, seatId]),
    ).rejects.toThrow(/order_items_event_id_seat_id_key/);
    expect(await count(`SELECT 1 FROM order_items WHERE event_id = $1 AND seat_id = $2`, [eventId, seatId])).toBe(1);
  });

  it("an order line must point at a real (event, seat) pair", async () => {
    const { orderId } = await paidSeat(11);
    await expect(db.pool.query(`INSERT INTO order_items (order_id, event_id, seat_id) VALUES ($1, 11, 999999)`, [orderId])).rejects.toThrow(/foreign key/);
  });

  it("one hold becomes at most one order (paying twice cannot create two orders)", async () => {
    const { eventId, userId, holdId } = await paidSeat(12);
    await expect(db.pool.query(`INSERT INTO orders (user_id, event_id, hold_id) VALUES ($1, $2, $3)`, [userId, eventId, holdId])).rejects.toThrow(/orders_hold_id_key/);
    expect(await count(`SELECT 1 FROM orders WHERE hold_id = $1`, [holdId])).toBe(1);
  });
});

describe("idempotency keys", () => {
  it("a key is unique per user: a second insert with the same key is refused, another user may use the same key", async () => {
    const [a, b] = await insertUsers(db.pool, 2);
    const insert = (userId: string | undefined, key: string) =>
      db.pool.query(`INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, 'h')`, [userId, key]);
    await insert(a, "key-1");
    await expect(insert(a, "key-1")).rejects.toThrow(/idempotency_keys_user_id_key_key/);
    await expect(insert(b, "key-1")).resolves.toBeDefined();
    await expect(insert(a, "key-2")).resolves.toBeDefined();
  });

  it("20 parallel first requests with the same key: exactly one gets to run, the rest are told it exists", async () => {
    const [userId] = await insertUsers(db.pool, 1);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.pool.query(`INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, 'race', 'h') ON CONFLICT (user_id, key) DO NOTHING RETURNING id`, [userId]),
      ),
    );
    expect(attempts.filter((result) => result.rowCount === 1)).toHaveLength(1);
  });
});

describe("event version (optimistic locking)", () => {
  const eventRow = async (id: number) =>
    (await db.pool.query<{ title: string; version: number; updated_at: Date }>(`SELECT title, version, updated_at FROM events WHERE id = $1`, [id])).rows[0];
  const notes = (id: number) => count(`SELECT 1 FROM outbox WHERE payload->>'eventId' = $1::text`, [id]);

  it("20 editors who all saw version 1: exactly one wins, the other 19 change nothing", async () => {
    const id = 20;
    const before = await eventRow(id);
    expect(before?.version).toBe(1);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.pool.query(`UPDATE events SET title = $1 WHERE id = $2 AND version = $3 RETURNING title`, [`Editor ${i}`, id, 1]),
      ),
    );
    const winners = results.filter((result) => result.rowCount === 1);
    expect(winners).toHaveLength(1);
    const after = await eventRow(id);
    expect(after?.version).toBe(2);
    expect(after?.title).toBe(winners[0]?.rows[0].title);
  });

  it("the database raises the version by one; a version written by the statement is ignored", async () => {
    const id = 21;
    await db.pool.query(`UPDATE events SET title = 'Changed', version = 99 WHERE id = $1`, [id]);
    expect((await eventRow(id))?.version).toBe(2);
    await db.pool.query(`UPDATE events SET city = 'Elsewhere', version = 1 WHERE id = $1`, [id]);
    expect((await eventRow(id))?.version).toBe(3);
  });

  it("an update that changes nothing keeps the version, the timestamp and writes no outbox note", async () => {
    const id = 22;
    const before = await eventRow(id);
    const notesBefore = await notes(id);
    await db.pool.query(`UPDATE events SET title = title, version = 50 WHERE id = $1`, [id]);
    const after = await eventRow(id);
    expect(after?.version).toBe(before?.version);
    expect(after?.updated_at).toEqual(before?.updated_at);
    expect(await notes(id)).toBe(notesBefore);
  });

  it("a real change moves updated_at forward", async () => {
    const id = 23;
    const before = await eventRow(id);
    await db.pool.query(`SELECT pg_sleep(0.05)`);
    await db.pool.query(`UPDATE events SET description = 'new text' WHERE id = $1`, [id]);
    const after = await eventRow(id);
    expect((after?.updated_at.getTime() ?? 0) > (before?.updated_at.getTime() ?? 0)).toBe(true);
  });
});

describe("outbox: every change of an event leaves exactly one note", () => {
  const notesOf = async (id: number) =>
    (await db.pool.query<{ payload: { eventId: number; version: number; op: string } }>(`SELECT payload FROM outbox WHERE payload->>'eventId' = $1::text ORDER BY id`, [id])).rows.map((row) => row.payload);

  it("insert, update and delete each write one note with the new version", async () => {
    const created = await db.pool.query<{ id: number }>(
      `INSERT INTO events (title, description, city, starts_at, hall_id) VALUES ('Outbox', '', 'Miami', now() + interval '2 days', 1) RETURNING id`,
    );
    const id = created.rows[0]?.id as number;
    await db.pool.query(`UPDATE events SET title = 'Outbox 2' WHERE id = $1`, [id]);
    await db.pool.query(`DELETE FROM events WHERE id = $1`, [id]);

    expect(await notesOf(id)).toEqual([
      { eventId: id, version: 1, op: "INSERT" },
      { eventId: id, version: 2, op: "UPDATE" },
      { eventId: id, version: 2, op: "DELETE" },
    ]);
  });

  it("a change made by hand in SQL is not forgotten, and a rolled-back change leaves no note", async () => {
    const id = 30;
    const before = (await notesOf(id)).length;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE events SET title = 'Never saved' WHERE id = $1`, [id]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect((await notesOf(id)).length).toBe(before);
    await db.pool.query(`UPDATE events SET title = 'Saved by hand' WHERE id = $1`, [id]);
    expect((await notesOf(id)).length).toBe(before + 1);
  });

  it("new notes start unprocessed", async () => {
    expect(await count(`SELECT 1 FROM outbox WHERE processed_at IS NOT NULL`)).toBe(0);
  });
});
