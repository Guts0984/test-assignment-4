import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/client";
import { verifyPassword } from "../src/password";
import { buildEvents, CITIES, EVENT_COUNT, HALLS, seed } from "../src/seed";
import { SEED_PASSWORDS } from "./global-setup";
import { createTestDb, type TestDb } from "./helpers";

// The seed runs against a real, empty, migrated PostgreSQL.

/** One seat row per seat of the hall of each event, worked out from the plan itself (not a magic number). */
const EXPECTED_EVENT_SEATS = buildEvents(new Date()).reduce((sum, event) => {
  const hall = HALLS[event.hallIndex];
  return sum + (hall ? hall.rows * hall.seatsPerRow : 0);
}, 0);

let testDb: TestDb;
let db: Db;
beforeEach(async () => {
  testDb = await createTestDb("empty");
  db = createDb(testDb.url);
});
afterEach(async () => {
  await db.$disconnect();
  await testDb.close();
});

/** A fingerprint of everything the seed writes. Same fingerprint = same data, row for row. */
async function fingerprint(): Promise<Record<string, string | number>> {
  const q = async (sql: string) => (await testDb.pool.query<{ v: string | number }>(sql)).rows[0]?.v ?? "";
  return {
    halls: await q(`SELECT md5(string_agg(id || name, ',' ORDER BY id)) AS v FROM halls`),
    seats: await q(`SELECT md5(string_agg(id || hall_id::text || "row" || number, ',' ORDER BY id)) AS v FROM seats`),
    users: await q(`SELECT md5(string_agg(id || email || role || password_hash, ',' ORDER BY email)) AS v FROM users`),
    events: await q(`SELECT md5(string_agg(id || title || description || city || starts_at::text || hall_id || version, ',' ORDER BY id)) AS v FROM events`),
    eventSeats: await q(`SELECT md5(string_agg(id || '-' || event_id || '-' || seat_id || status, ',' ORDER BY id)) AS v FROM event_seats`),
    outbox: await q(`SELECT count(*)::int AS v FROM outbox`),
  };
}

describe("seed", () => {
  it("creates what the assignment asks for: 2 halls of 120 and 200 seats, 100 events in 6 cities, 3 users", async () => {
    const summary = await seed(db, SEED_PASSWORDS);
    expect(summary).toEqual({ halls: 2, seats: 320, users: 3, events: 100, eventSeats: EXPECTED_EVENT_SEATS });

    const halls = await testDb.pool.query<{ name: string; seats: number; rows: number; per_row_max: number; distinct_places: number }>(
      `SELECT h.name, count(*)::int AS seats, count(DISTINCT s.row)::int AS rows, max(s.number)::int AS per_row_max,
              count(DISTINCT (s.row, s.number))::int AS distinct_places
       FROM halls h JOIN seats s ON s.hall_id = h.id GROUP BY h.name ORDER BY seats`,
    );
    expect(halls.rows.map((hall) => hall.seats)).toEqual([120, 200]);
    for (const hall of halls.rows) expect(hall.distinct_places).toBe(hall.seats); // rows x numbers, no gaps in counting
    expect(halls.rows.map((hall) => [hall.rows, hall.per_row_max])).toEqual([[8, 15], [10, 20]]);

    const cities = await testDb.pool.query<{ city: string }>(`SELECT DISTINCT city FROM events ORDER BY city`);
    expect(cities.rows.map((row) => row.city)).toEqual([...CITIES].sort());
  });

  it("every event has one FREE seat row for each seat of its hall, and nothing else", async () => {
    await seed(db, SEED_PASSWORDS);
    const mismatches = await testDb.pool.query(
      `SELECT e.id FROM events e
       WHERE (SELECT count(*) FROM event_seats es WHERE es.event_id = e.id) <> (SELECT count(*) FROM seats s WHERE s.hall_id = e.hall_id)
          OR EXISTS (SELECT 1 FROM event_seats es WHERE es.event_id = e.id AND es.status <> 'FREE')`,
    );
    expect(mismatches.rows).toEqual([]);
  });

  it("events are in the future, within the next two months, and both halls are used in every city", async () => {
    await seed(db, SEED_PASSWORDS);
    const window = await testDb.pool.query<{ past: number; too_far: number; min_days: number; max_days: number }>(
      `SELECT count(*) FILTER (WHERE starts_at <= now())::int AS past,
              count(*) FILTER (WHERE starts_at > now() + interval '60 days')::int AS too_far,
              min(extract(epoch FROM starts_at - now()) / 86400)::float AS min_days,
              max(extract(epoch FROM starts_at - now()) / 86400)::float AS max_days
       FROM events`,
    );
    expect(window.rows[0]).toMatchObject({ past: 0, too_far: 0 });
    expect(window.rows[0]?.min_days).toBeGreaterThan(0);
    expect(window.rows[0]?.max_days).toBeGreaterThan(50); // really spread over the period, not all tomorrow

    const halls = await testDb.pool.query<{ city: string; halls: number }>(`SELECT city, count(DISTINCT hall_id)::int AS halls FROM events GROUP BY city`);
    expect(halls.rows.every((row) => row.halls === 2)).toBe(true);
  });

  it("users: one admin, two ordinary users, passwords from the config (and only those)", async () => {
    await seed(db, SEED_PASSWORDS);
    const users = await testDb.pool.query<{ email: string; role: string; password_hash: string }>(`SELECT email, role, password_hash FROM users ORDER BY email`);
    expect(users.rows.map((user) => [user.email, user.role])).toEqual([
      ["admin@example.com", "ADMIN"],
      ["alice@example.com", "USER"],
      ["bob@example.com", "USER"],
    ]);
    const [admin, alice, bob] = users.rows;
    expect(await verifyPassword(SEED_PASSWORDS.adminPassword, admin?.password_hash ?? "")).toBe(true);
    expect(await verifyPassword(SEED_PASSWORDS.userPassword, alice?.password_hash ?? "")).toBe(true);
    expect(await verifyPassword(SEED_PASSWORDS.userPassword, bob?.password_hash ?? "")).toBe(true);
    // the passwords are not mixed up, and the plain text is not stored
    expect(await verifyPassword(SEED_PASSWORDS.userPassword, admin?.password_hash ?? "")).toBe(false);
    expect(await verifyPassword(SEED_PASSWORDS.adminPassword, alice?.password_hash ?? "")).toBe(false);
    expect(users.rows.some((user) => user.password_hash.includes(SEED_PASSWORDS.adminPassword) || user.password_hash.includes(SEED_PASSWORDS.userPassword))).toBe(false);
    // same password, different salt
    expect(alice?.password_hash).not.toBe(bob?.password_hash);
  });
});

describe("running the seed again", () => {
  it("changes nothing: every table is identical row for row, and no extra outbox notes appear", async () => {
    await seed(db, SEED_PASSWORDS);
    const first = await fingerprint();
    const second = await seed(db, SEED_PASSWORDS, new Date(Date.now() + 86_400_000)); // even "a day later"
    expect(second).toEqual({ halls: 2, seats: 320, users: 3, events: 100, eventSeats: EXPECTED_EVENT_SEATS });
    expect(await fingerprint()).toEqual(first);
    expect(first.outbox).toBe(100);
  });

  it("does not undo what happened since: edited events, changed passwords and sold seats stay as they are", async () => {
    await seed(db, SEED_PASSWORDS);
    await testDb.pool.query(`UPDATE events SET title = 'Edited by the admin' WHERE id = 3`);
    await testDb.pool.query(`UPDATE users SET password_hash = 'changed-by-user' WHERE email = 'alice@example.com'`);
    await testDb.pool.query(`DELETE FROM events WHERE id = 4`);
    const [bob] = (await testDb.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'bob@example.com'`)).rows;
    const hold = await testDb.pool.query<{ id: string }>(`INSERT INTO holds (user_id, event_id, expires_at) VALUES ($1, 5, now() + interval '5 min') RETURNING id`, [bob?.id]);
    await testDb.pool.query(`UPDATE event_seats SET status = 'HELD', user_id = $1, hold_id = $2, held_until = now() + interval '5 min' WHERE event_id = 5 AND seat_id = (SELECT min(seat_id) FROM event_seats WHERE event_id = 5)`, [bob?.id, hold.rows[0]?.id]);

    await seed(db, SEED_PASSWORDS);

    const title = await testDb.pool.query(`SELECT title FROM events WHERE id = 3`);
    expect(title.rows[0].title).toBe("Edited by the admin");
    const alice = await testDb.pool.query(`SELECT password_hash FROM users WHERE email = 'alice@example.com'`);
    expect(alice.rows[0].password_hash).toBe("changed-by-user");
    const held = await testDb.pool.query(`SELECT count(*)::int AS n FROM event_seats WHERE event_id = 5 AND status = 'HELD' AND user_id = $1`, [bob?.id]);
    expect(held.rows[0].n).toBe(1);
    // events exist, so the seed does not add events back (an event deleted on purpose stays deleted)
    const events = await testDb.pool.query(`SELECT count(*)::int AS n FROM events`);
    expect(events.rows[0].n).toBe(99);
  });

  it("5 seeders started at the same moment (for example 5 containers) still produce exactly one set of data", async () => {
    const clients = Array.from({ length: 5 }, () => createDb(testDb.url));
    try {
      const results = await Promise.allSettled(clients.map((client) => seed(client, SEED_PASSWORDS)));
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()));
    }
    const counts = await testDb.pool.query(
      `SELECT (SELECT count(*) FROM halls)::int AS halls, (SELECT count(*) FROM seats)::int AS seats, (SELECT count(*) FROM users)::int AS users,
              (SELECT count(*) FROM events)::int AS events, (SELECT count(*) FROM event_seats)::int AS event_seats, (SELECT count(*) FROM outbox)::int AS outbox`,
    );
    expect(counts.rows[0]).toEqual({ halls: 2, seats: 320, users: 3, events: 100, event_seats: EXPECTED_EVENT_SEATS, outbox: 100 });
  });
});

describe("buildEvents (the plan of the 100 events)", () => {
  const now = new Date("2026-11-05T10:30:00Z");

  it("depends only on `now`: the same input gives the same events", () => {
    expect(buildEvents(now)).toEqual(buildEvents(new Date(now)));
    expect(buildEvents(now)).toHaveLength(EVENT_COUNT);
  });

  it("starts after `now`, at most 60 days ahead, in the evening, with distinct titles", () => {
    const events = buildEvents(now);
    for (const event of events) {
      const days = (event.startsAt.getTime() - now.getTime()) / 86_400_000;
      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(60); // "the next two months"
      expect(event.startsAt.getUTCHours()).toBeGreaterThanOrEqual(17);
      expect(event.startsAt.getUTCHours()).toBeLessThanOrEqual(20);
      expect(event.title.length).toBeLessThanOrEqual(200);
    }
    expect(new Set(events.map((event) => event.title)).size).toBe(EVENT_COUNT);
  });

  it("uses all cities, both halls, and no city is tied to a single hall", () => {
    const events = buildEvents(now);
    expect(new Set(events.map((event) => event.city))).toEqual(new Set(CITIES));
    for (const city of CITIES) {
      const halls = new Set(events.filter((event) => event.city === city).map((event) => event.hallIndex));
      expect(halls.size).toBe(HALLS.length);
    }
  });
});
