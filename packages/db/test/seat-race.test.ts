import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, insertUsers, mulberry32, paySeats, seatIdsOf, takeSeats, type TestDb } from "./helpers";

// These tests talk to a REAL PostgreSQL and fire many truly parallel connections at it. They check what the
// DATABASE guarantees (the unique rows, the conditional UPDATE, the 6-seat trigger, the guard trigger), not
// what some application code promises.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb("seeded");
});
afterAll(async () => {
  await db.close();
});

type SeatRow = { seat_id: number; status: string; user_id: string | null; hold_id: string | null };
async function seatRows(eventId: number, seatIds: number[]): Promise<SeatRow[]> {
  const result = await db.pool.query<SeatRow>(
    `SELECT seat_id, status, user_id, hold_id FROM event_seats WHERE event_id = $1 AND seat_id = ANY($2) ORDER BY seat_id`,
    [eventId, seatIds],
  );
  return result.rows;
}

/** A user's id is needed for every hold; the seeded database has 3, tests that need more add their own. */
async function freshEvent(): Promise<number> {
  // Each test uses its own event so the tests do not see each other's seats. Events 1..100 exist in the seed.
  freshEvent.next += 1;
  return freshEvent.next;
}
freshEvent.next = 0;

describe("200 buyers fight for 10 seats", () => {
  it("each seat ends up with exactly one owner, and the owners are exactly the buyers who were told 'yes'", async () => {
    const eventId = await freshEvent();
    const seatIds = await seatIdsOf(db.pool, eventId, 10);
    const users = await insertUsers(db.pool, 200);

    // 200 requests at the same moment, 20 for each of the 10 seats.
    const results = await Promise.all(
      users.map((userId, i) => takeSeats(db.pool, userId, eventId, [seatIds[i % 10] as number])),
    );

    const winners = users.filter((_, i) => results[i]?.ok);
    expect(winners).toHaveLength(10);

    const rows = await seatRows(eventId, seatIds);
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.status === "HELD")).toBe(true);
    // No seat has two owners, no owner has two of these seats, and the owners are exactly the winners.
    const owners = rows.map((row) => row.user_id);
    expect(new Set(owners).size).toBe(10);
    expect([...owners].sort()).toEqual([...winners].sort());
    // The winner of each seat is also the one whose hold id is on the seat.
    for (const row of rows) {
      const index = users.indexOf(row.user_id as string);
      const result = results[index];
      expect(result?.ok && result.holdId).toBe(row.hold_id);
    }
    // And losers left nothing behind: one hold per winner, none for the 190 who lost.
    const holds = await db.pool.query(`SELECT count(*)::int AS n FROM holds WHERE event_id = $1`, [eventId]);
    expect(holds.rows[0].n).toBe(10);
  });

  it("buyers who want several seats at once get all of them or none, and nobody deadlocks", async () => {
    const eventId = await freshEvent();
    const seatIds = await seatIdsOf(db.pool, eventId, 10);
    const users = await insertUsers(db.pool, 200);
    const random = mulberry32(42);

    // Each buyer wants 2..4 of the 10 seats, in a random order, so many requests overlap in complicated ways.
    const wishes = users.map(() => {
      const size = 2 + Math.floor(random() * 3);
      const shuffled = [...seatIds].sort(() => random() - 0.5);
      return shuffled.slice(0, size);
    });
    const results = await Promise.all(users.map((userId, i) => takeSeats(db.pool, userId, eventId, wishes[i] as number[])));
    // (a deadlock or any unexpected database error would have made takeSeats throw and failed the test here)

    const rows = await seatRows(eventId, seatIds);
    const heldRows = rows.filter((row) => row.status === "HELD");
    const winnerIndexes = results.flatMap((result, i) => (result.ok ? [i] : []));
    expect(winnerIndexes.length).toBeGreaterThan(0);

    // Every winner owns exactly the seats they asked for, no more and no less.
    for (const i of winnerIndexes) {
      const owned = heldRows.filter((row) => row.user_id === users[i]).map((row) => row.seat_id);
      expect(owned.sort()).toEqual([...(wishes[i] as number[])].sort());
    }
    // Seats owned by winners add up exactly, so no seat is owned twice and no seat is owned by a loser.
    const total = winnerIndexes.reduce((sum, i) => sum + (wishes[i] as number[]).length, 0);
    expect(heldRows).toHaveLength(total);
    const winnerIds = new Set(winnerIndexes.map((i) => users[i]));
    expect(heldRows.every((row) => winnerIds.has(row.user_id as string))).toBe(true);
  });

  it("200 buyers each ask for ALL of the same 10 seats: the 6-seat rule means nobody gets any", async () => {
    const eventId = await freshEvent();
    const seatIds = await seatIdsOf(db.pool, eventId, 10);
    const users = await insertUsers(db.pool, 200);

    const results = await Promise.all(users.map((userId) => takeSeats(db.pool, userId, eventId, seatIds)));

    expect(results.every((result) => !result.ok)).toBe(true);
    const rows = await seatRows(eventId, seatIds);
    expect(rows.every((row) => row.status === "FREE" && row.user_id === null)).toBe(true);
  });
});

describe("the database refuses to give a seat to a second buyer, even if the code is wrong", () => {
  it("50 parallel UPDATEs without any 'is it free?' check: exactly one succeeds, 49 are refused", async () => {
    const eventId = await freshEvent();
    const [seatId] = await seatIdsOf(db.pool, eventId, 1);
    const users = await insertUsers(db.pool, 50);

    // The careless statement: it forgets "WHERE status = 'FREE'". The guard trigger must stop it.
    const attempts = await Promise.all(
      users.map(async (userId) => {
        const client = await db.pool.connect();
        const holdId = randomUUID();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO holds (id, user_id, event_id, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')`,
            [holdId, userId, eventId],
          );
          await client.query(
            `UPDATE event_seats SET status = 'HELD', user_id = $1, hold_id = $2, held_until = now() + interval '10 minutes'
             WHERE event_id = $3 AND seat_id = $4`,
            [userId, holdId, eventId, seatId],
          );
          await client.query("COMMIT");
          return { ok: true as const, userId };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
        } finally {
          client.release();
        }
      }),
    );

    const winners = attempts.filter((attempt) => attempt.ok);
    expect(winners).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.ok).every((attempt) => attempt.message === "seat_not_available")).toBe(true);
    const [row] = await seatRows(eventId, [seatId as number]);
    expect(row?.user_id).toBe(winners[0]?.userId);
  });

  it("a sold seat can never change owner or go back on sale", async () => {
    const eventId = await freshEvent();
    const [seatId] = await seatIdsOf(db.pool, eventId, 1);
    const [alice, mallory] = await insertUsers(db.pool, 2);
    const taken = await takeSeats(db.pool, alice as string, eventId, [seatId as number]);
    if (!taken.ok) throw new Error("setup failed");
    await paySeats(db.pool, taken.holdId);

    const steal = db.pool.query(
      `UPDATE event_seats SET status = 'HELD', user_id = $1, hold_id = $2, held_until = now() + interval '10 minutes'
       WHERE event_id = $3 AND seat_id = $4`,
      [mallory, taken.holdId, eventId, seatId],
    );
    await expect(steal).rejects.toThrow(/seat_already_sold|violates foreign key|seat_not_available/);

    // Putting a sold seat back on sale is refused too ...
    await expect(
      db.pool.query(
        `UPDATE event_seats SET status = 'FREE', user_id = NULL, hold_id = NULL, held_until = NULL WHERE event_id = $1 AND seat_id = $2`,
        [eventId, seatId],
      ),
    ).rejects.toThrow("seat_already_sold");
    // ... and so is a perfectly polite attempt to take it with the right WHERE: it just matches nothing.
    const polite = await takeSeats(db.pool, mallory as string, eventId, [seatId as number]);
    expect(polite).toEqual({ ok: false, reason: "taken" });

    const [row] = await seatRows(eventId, [seatId as number]);
    expect(row).toMatchObject({ status: "SOLD", user_id: alice });
  });

  it("which event and which physical seat a row stands for cannot be changed", async () => {
    const eventId = await freshEvent();
    const [a, b] = await seatIdsOf(db.pool, eventId, 2);
    await expect(
      db.pool.query(`UPDATE event_seats SET seat_id = $1 WHERE event_id = $2 AND seat_id = $3`, [b, eventId, a]),
    ).rejects.toThrow("seat_identity_immutable");
  });
});

describe("expired holds", () => {
  it("a seat whose hold ran out can be taken by someone else at once, without waiting for any cleanup", async () => {
    const eventId = await freshEvent();
    const [seatId] = await seatIdsOf(db.pool, eventId, 1);
    const [alice, bob] = await insertUsers(db.pool, 2);
    const first = await takeSeats(db.pool, alice as string, eventId, [seatId as number]);
    expect(first.ok).toBe(true);

    // Before the deadline Bob cannot have it.
    expect(await takeSeats(db.pool, bob as string, eventId, [seatId as number])).toEqual({ ok: false, reason: "taken" });

    // Ten minutes pass (we move the deadline into the past, as time would).
    await db.pool.query(`UPDATE event_seats SET held_until = now() - interval '1 second' WHERE event_id = $1 AND seat_id = $2`, [eventId, seatId]);

    const second = await takeSeats(db.pool, bob as string, eventId, [seatId as number]);
    expect(second.ok).toBe(true);
    const [row] = await seatRows(eventId, [seatId as number]);
    expect(row).toMatchObject({ status: "HELD", user_id: bob });
  });

  it("expired seats no longer count towards the 6-seat limit", async () => {
    const eventId = await freshEvent();
    const seatIds = await seatIdsOf(db.pool, eventId, 12);
    const [alice] = await insertUsers(db.pool, 1);
    expect((await takeSeats(db.pool, alice as string, eventId, seatIds.slice(0, 6))).ok).toBe(true);
    // Six valid holds: the 7th seat is refused.
    expect(await takeSeats(db.pool, alice as string, eventId, [seatIds[6] as number])).toEqual({ ok: false, reason: "limit" });

    await db.pool.query(`UPDATE event_seats SET held_until = now() - interval '1 second' WHERE event_id = $1 AND user_id = $2`, [eventId, alice]);
    // The old holds ran out: Alice may take six new seats.
    expect((await takeSeats(db.pool, alice as string, eventId, seatIds.slice(6, 12))).ok).toBe(true);
  });
});

describe("at most 6 seats per user per event", () => {
  it("20 parallel requests from ONE user for 20 different seats: exactly 6 succeed", async () => {
    const eventId = await freshEvent();
    const seatIds = await seatIdsOf(db.pool, eventId, 20);
    const [alice] = await insertUsers(db.pool, 1);

    const results = await Promise.all(seatIds.map((seatId) => takeSeats(db.pool, alice as string, eventId, [seatId])));

    expect(results.filter((result) => result.ok)).toHaveLength(6);
    expect(results.filter((result) => !result.ok && result.reason === "limit")).toHaveLength(14);
    const mine = await db.pool.query(`SELECT count(*)::int AS n FROM event_seats WHERE event_id = $1 AND user_id = $2`, [eventId, alice]);
    expect(mine.rows[0].n).toBe(6);
  });

  it("holds and bought seats are added together", async () => {
    const eventId = await freshEvent();
    const seatIds = await seatIdsOf(db.pool, eventId, 10);
    const [alice] = await insertUsers(db.pool, 1);
    const bought = await takeSeats(db.pool, alice as string, eventId, seatIds.slice(0, 4));
    if (!bought.ok) throw new Error("setup failed");
    await paySeats(db.pool, bought.holdId);

    // 4 sold + 2 held = 6 is allowed, the 7th is not.
    expect((await takeSeats(db.pool, alice as string, eventId, seatIds.slice(4, 6))).ok).toBe(true);
    expect(await takeSeats(db.pool, alice as string, eventId, [seatIds[6] as number])).toEqual({ ok: false, reason: "limit" });
  });

  it("paying for a hold does not trip the limit with the seats it already counts", async () => {
    const eventId = await freshEvent();
    const seatIds = await seatIdsOf(db.pool, eventId, 6);
    const [alice] = await insertUsers(db.pool, 1);
    const hold = await takeSeats(db.pool, alice as string, eventId, seatIds);
    if (!hold.ok) throw new Error("setup failed");
    await expect(paySeats(db.pool, hold.holdId)).resolves.toBeUndefined();
    const sold = await db.pool.query(`SELECT count(*)::int AS n FROM event_seats WHERE event_id = $1 AND status = 'SOLD'`, [eventId]);
    expect(sold.rows[0].n).toBe(6);
  });

  it("the limit is per event: 6 seats at one event do not stop 6 at another", async () => {
    const first = await freshEvent();
    const second = await freshEvent();
    const [alice] = await insertUsers(db.pool, 1);
    expect((await takeSeats(db.pool, alice as string, first, await seatIdsOf(db.pool, first, 6))).ok).toBe(true);
    expect((await takeSeats(db.pool, alice as string, second, await seatIdsOf(db.pool, second, 6))).ok).toBe(true);
  });

  it("a refused request changes nothing, even the seats it could have taken before hitting the limit", async () => {
    const eventId = await freshEvent();
    const seatIds = await seatIdsOf(db.pool, eventId, 7);
    const [alice] = await insertUsers(db.pool, 1);

    expect(await takeSeats(db.pool, alice as string, eventId, seatIds)).toEqual({ ok: false, reason: "limit" });
    const rows = await seatRows(eventId, seatIds);
    expect(rows.every((row) => row.status === "FREE")).toBe(true);
    const holds = await db.pool.query(`SELECT count(*)::int AS n FROM holds WHERE user_id = $1`, [alice]);
    expect(holds.rows[0].n).toBe(0);
  });
});
