import { randomUUID } from "node:crypto";
import { ErrorCode, holdSchema, orderSchema, seatMapSchema, type HoldDto, type OrderDto, type SeatMap } from "@app/shared";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { SessionStore } from "../src/auth/session";
import { call, login, startApp, type Reply, type TestApp } from "./helpers";

// Two api instances on ONE database and ONE Redis, exactly like the two containers of the real stack.
let a: TestApp;
let b: TestApp;
let sql: Client;
let sessions: SessionStore;
const passwords = inject("seedPasswords");
let nextEvent = 0;
/** The rate limit has its own tests; here hundreds of requests come from one address within seconds. */
const NO_LIMIT = { RATE_LIMIT_MAX: "1000000" };

beforeAll(async () => {
  a = await startApp({ env: NO_LIMIT });
  b = await startApp({ env: NO_LIMIT, databaseUrl: a.databaseUrl, flush: false });
  sql = new Client({ connectionString: a.databaseUrl });
  await sql.connect();
  sessions = new SessionStore(a.infra.redis, 3600);
});
afterAll(async () => {
  await sql.end();
  await Promise.all([a.close(), b.close()]);
});

type Person = { id: string; cookie: string };

/** Makes users with ready sessions directly (hashing 200 passwords would only slow the test down). */
async function makePeople(count: number): Promise<Person[]> {
  const prefix = `p${randomUUID().slice(0, 8)}`;
  const created = await sql.query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash) SELECT $1 || g || '@test.local', 'x' FROM generate_series(1, $2::int) g RETURNING id, email`,
    [prefix, count],
  );
  return Promise.all(created.rows.map(async (row) => ({ id: row.id, cookie: `sid=${await sessions.create({ userId: row.id, email: row.email, role: "user" })}` })));
}

/** A fresh event each time, so tests cannot see each other's seats. Events 1..100 exist; the first 5 are left to the others. */
const freshEvent = (): number => 5 + ++nextEvent;

/** The ids of the first `count` seats of an event's hall. */
async function seatsOf(eventId: number, count = 12): Promise<number[]> {
  const result = await sql.query<{ id: number }>(`SELECT s.id FROM seats s JOIN events e ON e.hall_id = s.hall_id WHERE e.id = $1 ORDER BY s.id LIMIT $2`, [eventId, count]);
  return result.rows.map((row) => row.id);
}

const key = () => `key-${randomUUID()}`;
const hold = (who: Person, eventId: number, seatIds: number[], idempotencyKey = key(), instance: TestApp = a): Promise<Reply> =>
  call(instance.base, `/events/${eventId}/holds`, { cookie: who.cookie, body: { seatIds }, headers: { "idempotency-key": idempotencyKey } });
const holdOf = (reply: Reply): HoldDto => holdSchema.parse((reply.body as { hold: unknown }).hold);
const orderOf = (reply: Reply): OrderDto => orderSchema.parse((reply.body as { order: unknown }).order);
const seatRows = async (eventId: number) =>
  (await sql.query<{ seat_id: number; status: string; user_id: string | null; hold_id: string | null }>(`SELECT seat_id, status, user_id, hold_id FROM event_seats WHERE event_id = $1`, [eventId])).rows;
/** Makes the hold (and its seats) 11 minutes old, as if the time had passed. */
const ageHold = async (where: string, value: string) => {
  await sql.query(`UPDATE holds SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 second' WHERE ${where}`, [value]);
  await sql.query(`UPDATE event_seats SET held_until = now() - interval '1 second' WHERE ${where === "id = $1" ? "hold_id = $1" : "user_id = $1 AND status = 'HELD'"}`, [value]);
};
const errorCode = (reply: Reply) => (reply.body as { code?: string }).code;

describe("the seat map", () => {
  it("shows the whole hall, row by row, all free at the start; anybody may look", async () => {
    const eventId = freshEvent();
    const reply = await call(a.base, `/events/${eventId}/seats`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    const map: SeatMap = seatMapSchema.parse(reply.body);
    const seatCount = map.rows.reduce((sum, row) => sum + row.seats.length, 0);
    expect([120, 200]).toContain(seatCount);
    expect(map.rows.map((row) => row.label)).toEqual([...map.rows.map((row) => row.label)].sort());
    expect(map.rows.every((row) => row.seats.every((seat) => seat.status === "free" && !seat.mine))).toBe(true);
    expect(map.rows[0]?.seats.map((seat) => seat.number)).toEqual(Array.from({ length: map.rows[0]?.seats.length ?? 0 }, (_, i) => i + 1));
  });

  it("an unknown event, or an id that is not a number, is 404", async () => {
    for (const id of ["9999", "abc", "0", "-1", "1.5"]) expect((await call(a.base, `/events/${id}/seats`)).status, id).toBe(404);
  });

  it("a held seat is 'held' for everybody and 'mine' only for the one who holds it - and nobody learns who", async () => {
    const eventId = freshEvent();
    const [alice, bob] = await makePeople(2);
    const [seatId] = await seatsOf(eventId, 1);
    expect((await hold(alice as Person, eventId, [seatId as number])).status).toBe(201);
    const find = (map: SeatMap) => map.rows.flatMap((row) => row.seats).find((seat) => seat.id === seatId);

    const asAlice = seatMapSchema.parse((await call(b.base, `/events/${eventId}/seats`, { cookie: (alice as Person).cookie })).body);
    const asBob = seatMapSchema.parse((await call(b.base, `/events/${eventId}/seats`, { cookie: (bob as Person).cookie })).body);
    const asNobody = await call(a.base, `/events/${eventId}/seats`);
    expect(find(asAlice)).toMatchObject({ status: "held", mine: true });
    expect(find(asBob)).toMatchObject({ status: "held", mine: false });
    expect(find(seatMapSchema.parse(asNobody.body))).toMatchObject({ status: "held", mine: false });
    expect(asNobody.text).not.toContain((alice as Person).id);
  });

  it("is never stale: a change is in the very next read, on the other instance too", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const [seatId] = await seatsOf(eventId, 1);
    for (let round = 0; round < 10; round++) {
      const created = await hold(alice as Person, eventId, [seatId as number], key(), round % 2 ? a : b);
      expect(created.status).toBe(201);
      const seen = seatMapSchema.parse((await call(round % 2 ? b.base : a.base, `/events/${eventId}/seats`)).body);
      expect(seen.rows.flatMap((row) => row.seats).find((seat) => seat.id === seatId)?.status).toBe("held");
      await call(a.base, `/holds/${holdOf(created).id}`, { method: "DELETE", cookie: (alice as Person).cookie });
      const after = seatMapSchema.parse((await call(round % 2 ? a.base : b.base, `/events/${eventId}/seats`)).body);
      expect(after.rows.flatMap((row) => row.seats).find((seat) => seat.id === seatId)?.status).toBe("free");
    }
  });
});

describe("holding seats", () => {
  it("needs a login and an Idempotency-Key", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const [seatId] = await seatsOf(eventId, 1);
    expect((await call(a.base, `/events/${eventId}/holds`, { body: { seatIds: [seatId] }, headers: { "idempotency-key": key() } })).status).toBe(401);
    const noKey = await call(a.base, `/events/${eventId}/holds`, { cookie: (alice as Person).cookie, body: { seatIds: [seatId] } });
    expect(noKey.status).toBe(400);
    for (const bad of ["short", "has spaces in it", "x".repeat(129), "key/with/slashes-123"]) {
      expect((await hold(alice as Person, eventId, [seatId as number], bad)).status, bad).toBe(400);
    }
    expect((await seatRows(eventId)).every((seat) => seat.status === "FREE")).toBe(true);
  });

  it("creates a hold for 10 minutes with the seats in hall order", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 3);
    const reply = await hold(alice as Person, eventId, [...seatIds].reverse());
    expect(reply.status).toBe(201);
    const created = holdOf(reply);
    expect(created).toMatchObject({ eventId, status: "active" });
    expect(created.seats.map((seat) => seat.id)).toEqual(seatIds);
    const seconds = (Date.parse(created.expiresAt) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(590);
    expect(seconds).toBeLessThanOrEqual(600);
  });

  const bad: Array<[string, unknown]> = [
    ["no seats", { seatIds: [] }],
    ["seat ids missing", {}],
    ["not a list", { seatIds: 5 }],
    ["text ids", { seatIds: ["1"] }],
    ["fractions", { seatIds: [1.5] }],
    ["negative", { seatIds: [-1] }],
    ["zero", { seatIds: [0] }],
    ["enormous", { seatIds: [2 ** 40] }],
    ["the same seat twice", { seatIds: [1, 1] }],
    ["more than the request limit", { seatIds: Array.from({ length: 13 }, (_, i) => i + 1) }],
    ["an extra field", { seatIds: [1], userId: "someone-else" }],
    ["null", null],
  ];
  it.each(bad)("refuses %s with 400 and holds nothing", async (_name, body) => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const reply = await call(a.base, `/events/${eventId}/holds`, { cookie: (alice as Person).cookie, body, headers: { "idempotency-key": key() } });
    expect(reply.status).toBe(400);
    expect((await seatRows(eventId)).every((seat) => seat.status === "FREE")).toBe(true);
  });

  it("seats that do not belong to this event's hall are refused (400), and nothing is held", async () => {
    const [alice] = await makePeople(1);
    const hallA = await sql.query<{ id: number }>(`SELECT id FROM events WHERE hall_id = 1 ORDER BY id LIMIT 1 OFFSET 20`);
    const hallBSeats = await sql.query<{ id: number }>(`SELECT id FROM seats WHERE hall_id = 2 ORDER BY id LIMIT 2`);
    const eventId = hallA.rows[0]?.id as number;
    const reply = await hold(alice as Person, eventId, hallBSeats.rows.map((row) => row.id));
    expect(reply.status).toBe(400);
    expect((await sql.query(`SELECT 1 FROM holds WHERE event_id = $1`, [eventId])).rowCount).toBe(0);
  });

  it("an event that has already started cannot be booked", async () => {
    const [alice] = await makePeople(1);
    const past = await sql.query<{ id: number }>(`INSERT INTO events (title, description, city, starts_at, hall_id) VALUES ('Over', '', 'Past', now() - interval '1 hour', 1) RETURNING id`);
    const eventId = past.rows[0]?.id as number;
    await sql.query(`INSERT INTO event_seats (event_id, seat_id) SELECT $1, id FROM seats WHERE hall_id = 1`, [eventId]);
    const [seatId] = await seatsOf(eventId, 1);
    const reply = await hold(alice as Person, eventId, [seatId as number]);
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe(ErrorCode.EVENT_STARTED);
  });

  it("a missing event is 404", async () => {
    const [alice] = await makePeople(1);
    expect((await hold(alice as Person, 9999, [1])).status).toBe(404);
    expect((await hold(alice as Person, 9999, [1])).status).toBe(404);
  });
});

describe("200 buyers fight for the same 10 seats (acceptance check 7)", () => {
  it("one seat each: every seat goes to exactly one buyer; paying them all sells each seat exactly once", async () => {
    const eventId = freshEvent();
    const seatIds = await seatsOf(eventId, 10);
    const people = await makePeople(200);

    // 200 requests at the same moment, spread over both instances; each person wants one of the 10 seats.
    const replies = await Promise.all(people.map((person, i) => hold(person, eventId, [seatIds[i % 10] as number], key(), i % 2 ? a : b)));
    const winners = replies.flatMap((reply, i) => (reply.status === 201 ? [i] : []));
    expect(winners).toHaveLength(10);
    const refused = replies.filter((reply) => reply.status === 409);
    expect(refused).toHaveLength(190);
    expect(refused.every((reply) => errorCode(reply) === ErrorCode.SOLD_OUT)).toBe(true);
    // The refusal says which seat was taken.
    const wanted = (index: number) => seatIds[index % 10];
    replies.forEach((reply, i) => {
      if (reply.status === 409) expect((reply.body as { details: { seatIds: number[] } }).details.seatIds).toEqual([wanted(i)]);
    });
    expect(new Set(winners.map((i) => wanted(i))).size).toBe(10); // 10 winners, 10 different seats

    const held = (await seatRows(eventId)).filter((seat) => seat.status === "HELD");
    expect(held).toHaveLength(10);
    expect(new Set(held.map((seat) => seat.user_id)).size).toBe(10);
    for (const i of winners) expect(held.find((seat) => seat.seat_id === wanted(i))?.user_id).toBe((people[i] as Person).id);
    expect((await sql.query(`SELECT 1 FROM holds WHERE event_id = $1`, [eventId])).rowCount).toBe(10); // the 190 losers left no hold behind

    // Everybody who won pays - each one several times at once, from both instances.
    const payments = await Promise.all(
      winners.flatMap((i) => [0, 1, 2].map((n) => call((n % 2 ? a : b).base, `/holds/${holdOf(replies[i] as Reply).id}/pay`, { method: "POST", cookie: (people[i] as Person).cookie }))),
    );
    expect(payments.every((reply) => reply.status === 200)).toBe(true);
    const orders = new Set(payments.map((reply) => orderOf(reply).id));
    expect(orders.size).toBe(10); // paying three times gives the same order, not three
    const sold = (await seatRows(eventId)).filter((seat) => seat.status === "SOLD");
    expect(sold).toHaveLength(10);
    expect((await sql.query(`SELECT 1 FROM order_items WHERE event_id = $1`, [eventId])).rowCount).toBe(10);
    expect((await sql.query(`SELECT DISTINCT seat_id FROM order_items WHERE event_id = $1`, [eventId])).rowCount).toBe(10);
  }, 120_000);

  it("several seats each (2-4 of the 10): all or nothing, nobody gets half of what they asked for, no seat twice", async () => {
    const eventId = freshEvent();
    const seatIds = await seatsOf(eventId, 10);
    const people = await makePeople(200);
    const wishes = people.map((_, i) => {
      const size = 2 + (i % 3);
      return Array.from({ length: size }, (_, k) => seatIds[(i * 7 + k * 3) % 10] as number).filter((seat, k, all) => all.indexOf(seat) === k);
    });

    const replies = await Promise.all(people.map((person, i) => hold(person, eventId, wishes[i] as number[], key(), i % 2 ? a : b)));
    expect(replies.every((reply) => reply.status === 201 || reply.status === 409)).toBe(true);
    const winners = replies.flatMap((reply, i) => (reply.status === 201 ? [i] : []));
    expect(winners.length).toBeGreaterThan(0);

    const held = (await seatRows(eventId)).filter((seat) => seat.status === "HELD");
    for (const i of winners) {
      const mine = held.filter((seat) => seat.user_id === (people[i] as Person).id).map((seat) => seat.seat_id);
      expect(mine.sort()).toEqual([...(wishes[i] as number[])].sort());
    }
    expect(held).toHaveLength(winners.reduce((sum, i) => sum + (wishes[i] as number[]).length, 0));
    expect(new Set(held.map((seat) => seat.seat_id)).size).toBe(held.length);
  }, 120_000);

  it("a hold that was refused leaves nothing behind: not even a seat it won before it lost another", async () => {
    const eventId = freshEvent();
    const [first, second] = await makePeople(2);
    const [s1, s2, s3] = await seatsOf(eventId, 3);
    expect((await hold(first as Person, eventId, [s2 as number])).status).toBe(201);
    const refused = await hold(second as Person, eventId, [s1 as number, s2 as number, s3 as number]);
    expect(refused.status).toBe(409);
    expect((refused.body as { details: { seatIds: number[] } }).details.seatIds).toEqual([s2]);
    const rows = await seatRows(eventId);
    expect(rows.filter((seat) => seat.user_id === (second as Person).id)).toEqual([]);
    expect(rows.filter((seat) => seat.status === "HELD")).toHaveLength(1);
  });
});

describe("at most 6 seats per user per event (acceptance check 8)", () => {
  it("the 7th seat is refused with 409 SEAT_LIMIT_REACHED and the first 6 stay held", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 8);
    expect((await hold(alice as Person, eventId, seatIds.slice(0, 6))).status).toBe(201);
    const seventh = await hold(alice as Person, eventId, [seatIds[6] as number]);
    expect(seventh.status).toBe(409);
    expect(errorCode(seventh)).toBe(ErrorCode.SEAT_LIMIT_REACHED);
    expect((seventh.body as { details: { limit: number } }).details.limit).toBe(6);
    expect((await seatRows(eventId)).filter((seat) => seat.user_id === (alice as Person).id)).toHaveLength(6);
  });

  it("7 seats in ONE request are refused as a whole", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const reply = await hold(alice as Person, eventId, await seatsOf(eventId, 7));
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe(ErrorCode.SEAT_LIMIT_REACHED);
    expect((await seatRows(eventId)).filter((seat) => seat.status !== "FREE")).toEqual([]);
  });

  it("seats from different holds add up (3 + 3 is fine, one more is not), and bought seats count as well", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 8);
    const first = await hold(alice as Person, eventId, seatIds.slice(0, 3));
    expect((await hold(alice as Person, eventId, seatIds.slice(3, 6))).status).toBe(201);
    expect(errorCode(await hold(alice as Person, eventId, [seatIds[6] as number]))).toBe(ErrorCode.SEAT_LIMIT_REACHED);
    // buying the first three does not free any room
    expect((await call(a.base, `/holds/${holdOf(first).id}/pay`, { method: "POST", cookie: (alice as Person).cookie })).status).toBe(200);
    expect(errorCode(await hold(alice as Person, eventId, [seatIds[6] as number]))).toBe(ErrorCode.SEAT_LIMIT_REACHED);
  });

  it("20 requests from ONE user at the same moment, over both instances: exactly 6 seats", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 20);
    const replies = await Promise.all(seatIds.map((seatId, i) => hold(alice as Person, eventId, [seatId], key(), i % 2 ? a : b)));
    expect(replies.filter((reply) => reply.status === 201)).toHaveLength(6);
    expect(replies.filter((reply) => reply.status === 409 && errorCode(reply) === ErrorCode.SEAT_LIMIT_REACHED)).toHaveLength(14);
    expect((await seatRows(eventId)).filter((seat) => seat.user_id === (alice as Person).id)).toHaveLength(6);
  });

  it("the limit is per event", async () => {
    const [alice] = await makePeople(1);
    const first = freshEvent();
    const second = freshEvent();
    expect((await hold(alice as Person, first, await seatsOf(first, 6))).status).toBe(201);
    expect((await hold(alice as Person, second, await seatsOf(second, 6))).status).toBe(201);
  });

  it("when a hold is cancelled or runs out, the room comes back", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 8);
    const six = holdOf(await hold(alice as Person, eventId, seatIds.slice(0, 6)));
    expect(errorCode(await hold(alice as Person, eventId, [seatIds[6] as number]))).toBe(ErrorCode.SEAT_LIMIT_REACHED);
    await call(a.base, `/holds/${six.id}`, { method: "DELETE", cookie: (alice as Person).cookie });
    expect((await hold(alice as Person, eventId, seatIds.slice(0, 6))).status).toBe(201);
    await ageHold("user_id = $1 AND status = 'ACTIVE'", (alice as Person).id);
    expect((await hold(alice as Person, eventId, seatIds.slice(6, 8))).status).toBe(201);
  });
});

describe("Idempotency-Key (acceptance check 8)", () => {
  it("repeating the request with the same key returns the very same answer, and only one hold exists", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 2);
    const k = key();
    const first = await hold(alice as Person, eventId, seatIds, k);
    const second = await hold(alice as Person, eventId, seatIds, k, b);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect((await sql.query(`SELECT 1 FROM holds WHERE user_id = $1`, [(alice as Person).id])).rowCount).toBe(1);
  });

  it("the same seats in another order are the same request", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 3);
    const k = key();
    const first = await hold(alice as Person, eventId, seatIds, k);
    const second = await hold(alice as Person, eventId, [...seatIds].reverse(), k);
    expect(second.body).toEqual(first.body);
  });

  it("the same key for a DIFFERENT request is refused with 422", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 3);
    const k = key();
    expect((await hold(alice as Person, eventId, [seatIds[0] as number], k)).status).toBe(201);
    const other = await hold(alice as Person, eventId, [seatIds[1] as number], k);
    expect(other.status).toBe(422);
    expect(errorCode(other)).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);
    expect((await seatRows(eventId)).filter((seat) => seat.status === "HELD")).toHaveLength(1);
  });

  it("50 identical requests at the same moment over both instances: one hold, 50 identical answers", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 2);
    const k = key();
    const replies = await Promise.all(Array.from({ length: 50 }, (_, i) => hold(alice as Person, eventId, seatIds, k, i % 2 ? a : b)));
    expect(replies.every((reply) => reply.status === 201)).toBe(true);
    expect(new Set(replies.map((reply) => holdOf(reply).id)).size).toBe(1);
    expect((await sql.query(`SELECT 1 FROM holds WHERE user_id = $1`, [(alice as Person).id])).rowCount).toBe(1);
    expect(replies.filter((reply) => reply.headers.get("idempotent-replayed") === null)).toHaveLength(1);
  });

  it("the refused 7th seat answers the same way on a repeat, and still creates no hold", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 8);
    await hold(alice as Person, eventId, seatIds.slice(0, 6));
    const k = key();
    const first = await hold(alice as Person, eventId, [seatIds[6] as number], k);
    const second = await hold(alice as Person, eventId, [seatIds[6] as number], k);
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.body).toEqual(first.body);
    expect((await sql.query(`SELECT 1 FROM holds WHERE user_id = $1`, [(alice as Person).id])).rowCount).toBe(1);
  });

  it("a key belongs to one user: another user with the same key is a different request", async () => {
    const eventId = freshEvent();
    const [alice, bob] = await makePeople(2);
    const seatIds = await seatsOf(eventId, 2);
    const k = key();
    expect((await hold(alice as Person, eventId, [seatIds[0] as number], k)).status).toBe(201);
    expect((await hold(bob as Person, eventId, [seatIds[1] as number], k)).status).toBe(201);
  });

  it("a failure of ours is not remembered: after a crash the same key can run again", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const [seatId] = await seatsOf(eventId, 1);
    const k = key();
    // pretend an earlier request died half way: a note without an answer, older than the patience limit
    await sql.query(`INSERT INTO idempotency_keys (user_id, key, request_hash, created_at) VALUES ($1, $2, 'whatever', now() - interval '5 minutes')`, [(alice as Person).id, k]);
    const reply = await hold(alice as Person, eventId, [seatId as number], k);
    expect([201, 422]).toContain(reply.status); // a different hash: it is a different request, so 422 - never a hang
  });
});

describe("paying", () => {
  it("turns the hold into an order, sells the seats, and shows up in the orders list", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const seatIds = await seatsOf(eventId, 3);
    const created = holdOf(await hold(alice as Person, eventId, seatIds));
    const paid = await call(a.base, `/holds/${created.id}/pay`, { method: "POST", cookie: (alice as Person).cookie });
    expect(paid.status).toBe(200);
    const order = orderOf(paid);
    expect(order).toMatchObject({ eventId });
    expect(order.seats.map((seat) => seat.id)).toEqual(seatIds);

    const map = seatMapSchema.parse((await call(b.base, `/events/${eventId}/seats`, { cookie: (alice as Person).cookie })).body);
    expect(map.rows.flatMap((row) => row.seats).filter((seat) => seat.status === "sold" && seat.mine)).toHaveLength(3);

    const list = await call(b.base, "/me/orders", { cookie: (alice as Person).cookie });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect((list.body as { items: OrderDto[] }).items[0]).toEqual(order);
    expect((await call(a.base, `/holds/${created.id}`, { cookie: (alice as Person).cookie })).body).toMatchObject({ hold: { status: "paid" } });
  });

  it("paying twice (also at the same moment) gives the same order, never two", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const created = holdOf(await hold(alice as Person, eventId, await seatsOf(eventId, 2)));
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => call((i % 2 ? a : b).base, `/holds/${created.id}/pay`, { method: "POST", cookie: (alice as Person).cookie })));
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(new Set(replies.map((reply) => orderOf(reply).id)).size).toBe(1);
    expect((await sql.query(`SELECT 1 FROM orders WHERE hold_id = $1`, [created.id])).rowCount).toBe(1);
    expect((await sql.query(`SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.hold_id = $1`, [created.id])).rowCount).toBe(2);
  });

  it("a hold whose time ran out cannot be paid (409 BOOKING_EXPIRED) and its seats are released", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const created = holdOf(await hold(alice as Person, eventId, await seatsOf(eventId, 2)));
    await ageHold("id = $1", created.id);
    const late = await call(a.base, `/holds/${created.id}/pay`, { method: "POST", cookie: (alice as Person).cookie });
    expect(late.status).toBe(409);
    expect(errorCode(late)).toBe(ErrorCode.BOOKING_EXPIRED);
    expect((await seatRows(eventId)).every((seat) => seat.status === "FREE")).toBe(true);
    expect((await sql.query(`SELECT 1 FROM orders WHERE hold_id = $1`, [created.id])).rowCount).toBe(0);
  });

  it("an expired hold whose seats went to someone else cannot take them back", async () => {
    const eventId = freshEvent();
    const [alice, bob] = await makePeople(2);
    const [seatId] = await seatsOf(eventId, 1);
    const old = holdOf(await hold(alice as Person, eventId, [seatId as number]));
    await ageHold("id = $1", old.id);
    expect((await hold(bob as Person, eventId, [seatId as number])).status).toBe(201); // free at once, no waiting for the worker

    const late = await call(a.base, `/holds/${old.id}/pay`, { method: "POST", cookie: (alice as Person).cookie });
    expect(late.status).toBe(409);
    expect((await seatRows(eventId)).find((seat) => seat.seat_id === seatId)).toMatchObject({ status: "HELD", user_id: (bob as Person).id });
  });

  it("a cancelled hold cannot be paid", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const created = holdOf(await hold(alice as Person, eventId, await seatsOf(eventId, 1)));
    await call(a.base, `/holds/${created.id}`, { method: "DELETE", cookie: (alice as Person).cookie });
    const reply = await call(a.base, `/holds/${created.id}/pay`, { method: "POST", cookie: (alice as Person).cookie });
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe(ErrorCode.BOOKING_CANCELLED);
  });

  it("paying and cancelling at the same moment: one of them wins and the result is consistent", async () => {
    for (let round = 0; round < 5; round++) {
      const eventId = freshEvent();
      const [alice] = await makePeople(1);
      const created = holdOf(await hold(alice as Person, eventId, await seatsOf(eventId, 2)));
      const [pay, cancel] = await Promise.all([
        call(a.base, `/holds/${created.id}/pay`, { method: "POST", cookie: (alice as Person).cookie }),
        call(b.base, `/holds/${created.id}`, { method: "DELETE", cookie: (alice as Person).cookie }),
      ]);
      const rows = await seatRows(eventId);
      if (pay.status === 200) {
        expect(cancel.status).toBe(409); // too late to cancel
        expect(rows.filter((seat) => seat.status === "SOLD")).toHaveLength(2);
      } else {
        expect(pay.status).toBe(409);
        expect(cancel.status).toBe(204);
        expect(rows.every((seat) => seat.status === "FREE")).toBe(true);
      }
    }
  });

  it("someone else's booking looks exactly like one that does not exist (404), for reading, paying and cancelling", async () => {
    const eventId = freshEvent();
    const [alice, mallory] = await makePeople(2);
    const created = holdOf(await hold(alice as Person, eventId, await seatsOf(eventId, 1)));
    const ghost = randomUUID();
    const mine = async (path: string, method: string, id: string) => call(a.base, `/${path.replace(":id", id)}`, { method, cookie: (mallory as Person).cookie });
    for (const [path, method] of [["holds/:id", "GET"], ["holds/:id/pay", "POST"], ["holds/:id", "DELETE"]] as const) {
      const theirs = await mine(path, method, created.id);
      const none = await mine(path, method, ghost);
      expect(theirs.status).toBe(404);
      expect(theirs.body).toEqual(none.body);
    }
    expect((await seatRows(eventId)).filter((seat) => seat.status === "HELD")).toHaveLength(1);
    for (const id of ["not-a-uuid", "1", "%00", "'; DROP TABLE holds; --"]) {
      expect((await mine("holds/:id", "GET", encodeURIComponent(id))).status, id).toBeLessThan(500);
    }
  });
});

describe("cancelling", () => {
  it("frees the seats at once and may be repeated", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const created = holdOf(await hold(alice as Person, eventId, await seatsOf(eventId, 2)));
    expect((await call(a.base, `/holds/${created.id}`, { method: "DELETE", cookie: (alice as Person).cookie })).status).toBe(204);
    expect((await seatRows(eventId)).every((seat) => seat.status === "FREE" && seat.user_id === null)).toBe(true);
    expect((await call(b.base, `/holds/${created.id}`, { method: "DELETE", cookie: (alice as Person).cookie })).status).toBe(204);
    expect((await call(a.base, `/holds/${created.id}`, { cookie: (alice as Person).cookie })).body).toMatchObject({ hold: { status: "cancelled" } });
  });

  it("a paid booking cannot be cancelled", async () => {
    const eventId = freshEvent();
    const [alice] = await makePeople(1);
    const created = holdOf(await hold(alice as Person, eventId, await seatsOf(eventId, 1)));
    await call(a.base, `/holds/${created.id}/pay`, { method: "POST", cookie: (alice as Person).cookie });
    const reply = await call(a.base, `/holds/${created.id}`, { method: "DELETE", cookie: (alice as Person).cookie });
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe(ErrorCode.ALREADY_PAID);
    expect((await seatRows(eventId)).filter((seat) => seat.status === "SOLD")).toHaveLength(1);
  });

  it("the freed seats can be taken by another user straight away", async () => {
    const eventId = freshEvent();
    const [alice, bob] = await makePeople(2);
    const [seatId] = await seatsOf(eventId, 1);
    const created = holdOf(await hold(alice as Person, eventId, [seatId as number]));
    expect((await hold(bob as Person, eventId, [seatId as number])).status).toBe(409);
    await call(a.base, `/holds/${created.id}`, { method: "DELETE", cookie: (alice as Person).cookie });
    expect((await hold(bob as Person, eventId, [seatId as number])).status).toBe(201);
  });
});

describe("orders are private (acceptance check 14, API part)", () => {
  it("/me/orders needs a login, shows only the caller's orders, and says it must not be cached by anybody", async () => {
    const eventId = freshEvent();
    const [alice, bob] = await makePeople(2);
    const seatIds = await seatsOf(eventId, 2);
    const created = holdOf(await hold(alice as Person, eventId, [seatIds[0] as number]));
    await call(a.base, `/holds/${created.id}/pay`, { method: "POST", cookie: (alice as Person).cookie });

    expect((await call(a.base, "/me/orders")).status).toBe(401);
    const asBob = await call(a.base, "/me/orders", { cookie: (bob as Person).cookie });
    expect(asBob.status).toBe(200);
    expect(asBob.body).toEqual({ items: [] });
    const asAlice = await call(a.base, "/me/orders", { cookie: (alice as Person).cookie });
    expect((asAlice.body as { items: unknown[] }).items).toHaveLength(1);
    expect(asAlice.headers.get("cache-control")).toBe("private, no-store");
    expect(asAlice.headers.get("set-cookie")).toBeNull();
  });

  it("a logged-in seeded user can do the whole thing with a real login too", async () => {
    const eventId = freshEvent();
    const { cookie } = await login(a.base, "alice@example.com", passwords.user);
    const person: Person = { id: "", cookie };
    const created = await hold(person, eventId, (await seatsOf(eventId, 1)));
    expect(created.status).toBe(201);
    expect((await call(a.base, `/holds/${holdOf(created).id}/pay`, { method: "POST", cookie })).status).toBe(200);
  });
});
