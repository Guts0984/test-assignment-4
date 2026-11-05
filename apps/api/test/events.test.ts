import { apiErrorSchema, ErrorCode, eventListSchema, eventSchema, type EventDto, type EventList } from "@app/shared";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { call, login, startApp, type Reply, type TestApp } from "./helpers";

// Two instances of the api that share ONE database and ONE Redis, like the two containers in the real stack.
let a: TestApp;
let b: TestApp;
let sql: Client;
let admin: string;
let alice: string;
const passwords = inject("seedPasswords");
/** The rate limit has its own tests; here hundreds of requests come from one address within seconds. */
const NO_LIMIT = { RATE_LIMIT_MAX: "1000000" };

/** SQL statements that touched the events table, per instance (the real queries the database received from the api). */
const queries = { a: [] as string[], b: [] as string[] };
const eventQueries = () => queries.a.length + queries.b.length;
const resetCount = () => {
  queries.a.length = 0;
  queries.b.length = 0;
};
const touchesEvents = (statement: string) => /FROM\s+"public"\."events"/i.test(statement);

beforeAll(async () => {
  a = await startApp({ env: NO_LIMIT, onQuery: (statement) => touchesEvents(statement) && queries.a.push(statement) });
  b = await startApp({ env: NO_LIMIT, databaseUrl: a.databaseUrl, flush: false, onQuery: (statement) => touchesEvents(statement) && queries.b.push(statement) });
  sql = new Client({ connectionString: a.databaseUrl });
  await sql.connect();
  admin = (await login(a.base, "admin@example.com", passwords.admin)).cookie;
  alice = (await login(a.base, "alice@example.com", passwords.user)).cookie;
});
afterAll(async () => {
  await sql.end();
  await Promise.all([a.close(), b.close()]);
});

const bump = () => a.infra.redis.incr("gen:events"); // what the worker does when it notices a change made behind the api's back
const listOf = async (path: string, base = a.base): Promise<EventList> => {
  const reply = await call(base, path);
  expect(reply.status, reply.text.slice(0, 300)).toBe(200);
  return eventListSchema.parse(reply.body);
};
const eventOf = async (id: number | string, base = a.base): Promise<EventDto> => {
  const reply = await call(base, `/events/${id}`);
  expect(reply.status).toBe(200);
  return eventSchema.parse(reply.body);
};
const expectError = (reply: Reply, status: number, code?: string) => {
  expect(reply.status, reply.text.slice(0, 300)).toBe(status);
  expect(apiErrorSchema.safeParse(reply.body).success).toBe(true);
  if (code) expect((reply.body as { code: string }).code).toBe(code);
};

describe("GET /events: the list", () => {
  it("returns upcoming events, soonest first, 20 per page by default", async () => {
    const page = await listOf("/events");
    expect(page.items).toHaveLength(20);
    const times = page.items.map((event) => Date.parse(event.startsAt));
    expect(times.every((time) => time > Date.now())).toBe(true);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(page.nextCursor).not.toBeNull();
  });

  it("the cursor walks through ALL 100 events exactly once, for any page size", async () => {
    for (const limit of [1, 7, 20, 33, 50]) {
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 200; guard++) {
        const page: EventList = await listOf(`/events?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...page.items.map((event) => event.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen, `limit ${limit}`).toHaveLength(100);
      expect(new Set(seen).size, `limit ${limit}: no event twice`).toBe(100);
    }
  });

  it("events that start at the very same moment are not lost or repeated between pages", async () => {
    // 5 events at the same minute, then a page size that cuts right through them
    const start = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    for (let i = 0; i < 5; i++) await sql.query(`INSERT INTO events (title, description, city, starts_at, hall_id) VALUES ($1, '', 'Tie', $2, 1)`, [`Tie ${i}`, start]);
    await bump();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: EventList = await listOf(`/events?city=tie&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.items.map((event) => event.title));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(["Tie 0", "Tie 1", "Tie 2", "Tie 3", "Tie 4"]);
  });

  it("filters by city (any letter case) and the counts add up", async () => {
    const moscow = await listOf("/events?city=moscow&limit=50");
    expect(moscow.items.length).toBeGreaterThan(10);
    expect(moscow.items.every((event) => event.city === "Moscow")).toBe(true);
    expect((await listOf("/events?city=MOSCOW&limit=50")).items.length).toBe(moscow.items.length);
    expect((await listOf("/events?city=Atlantis")).items).toEqual([]);
  });

  it("searches the title, ignoring letter case", async () => {
    const found = await listOf("/events?q=CONCERT&limit=50");
    expect(found.items.length).toBeGreaterThan(5);
    expect(found.items.every((event) => event.title.toLowerCase().includes("concert"))).toBe(true);
  });

  it("search characters mean themselves: % and _ are not wildcards, quotes do not break anything", async () => {
    for (const q of ["%", "_", "\\", "' OR 1=1 --", "\"; DROP TABLE events; --", "a%b", "%%"]) {
      const result = await listOf(`/events?q=${encodeURIComponent(q)}`);
      expect(result.items, `q=${q}`).toEqual([]);
    }
    expect(await sql.query("SELECT count(*)::int AS n FROM events")).toMatchObject({ rows: [{ n: expect.any(Number) }] });
  });

  it("filters by dates; a plain day as the end includes that whole day", async () => {
    const all = (await listOf("/events?limit=50")).items;
    const target = all[10] as EventDto;
    const day = target.startsAt.slice(0, 10);
    const sameDay = await listOf(`/events?from=${day}&to=${day}&limit=50`);
    expect(sameDay.items.map((event) => event.id)).toContain(target.id);
    expect(sameDay.items.every((event) => event.startsAt.startsWith(day))).toBe(true);
    const after = await listOf(`/events?from=${encodeURIComponent(target.startsAt)}&limit=50`);
    expect(after.items[0]?.id).toBe(target.id);
    expect((await listOf(`/events?from=2099-01-01`)).items).toEqual([]);
    expect((await listOf(`/events?from=2030-01-02&to=2030-01-01`)).items).toEqual([]);
  });

  it("past events are not listed - but the event itself can still be opened", async () => {
    const past = await sql.query<{ id: number }>(`INSERT INTO events (title, description, city, starts_at, hall_id) VALUES ('Long gone', '', 'Past', now() - interval '3 days', 1) RETURNING id`);
    await bump();
    const id = past.rows[0]?.id as number;
    expect((await listOf("/events?city=past")).items).toEqual([]);
    expect((await listOf("/events?q=long%20gone")).items).toEqual([]);
    expect((await eventOf(id)).title).toBe("Long gone");
  });

  it("an event that starts while its page is cached disappears from the list at once", async () => {
    const soon = await sql.query<{ id: number }>(`INSERT INTO events (title, description, city, starts_at, hall_id) VALUES ('Starting now', '', 'Soon', now() + interval '1500 milliseconds', 1) RETURNING id`);
    await bump();
    expect((await listOf("/events?city=soon")).items.map((event) => event.id)).toEqual([soon.rows[0]?.id]);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect((await listOf("/events?city=soon")).items).toEqual([]);
  });

  const badQueries = [
    "limit=0", "limit=51", "limit=-1", "limit=abc", "limit=1.5", "limit=1e3", "limit=99999999999999999999",
    "cursor=!!!", "cursor=%00", "cursor=" + "A".repeat(500), `cursor=${Buffer.from("not json").toString("base64url")}`,
    `cursor=${Buffer.from(JSON.stringify({ t: "x", i: 1 })).toString("base64url")}`,
    `cursor=${Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: "1; DROP" })).toString("base64url")}`,
    `cursor=${Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: 1e30 })).toString("base64url")}`,
    "from=yesterday", "from=2026-13-45", "to=%00", "city=" + "x".repeat(101), "city[]=a", "q[a]=b", "q=a&q=b", "unknown=1", "city=a%00b", "q=%00",
  ];
  it.each(badQueries)("a bad query (%s) is a clean 400, never a 5xx", async (query) => {
    const reply = await call(a.base, `/events?${query}`);
    expectError(reply, 400, ErrorCode.VALIDATION_ERROR);
  });

  it("empty filters are the same as no filters", async () => {
    expect((await listOf("/events?city=&q=&from=&to=&cursor=&limit=")).items).toHaveLength(20);
  });
});

describe("GET /events/:id", () => {
  it("returns one event in the documented shape, with its hall", async () => {
    const event = await eventOf(1);
    expect(event).toMatchObject({ id: 1, version: 1 });
    expect(event.hall.name).toMatch(/Hall/);
    expect(Number.isNaN(Date.parse(event.startsAt))).toBe(false);
  });

  const missing = ["9999", "abc", "0", "-1", "1.5", "1e3", "007", "99999999999999999999", "2147483648", "%20", "null", "1;DROP", "%2e%2e", "٣", "1%00", "%00", "true", "NaN", "0x10"];
  it.each(missing)("/events/%s is 404 NOT_FOUND in the standard format (acceptance check 6)", async (id) => {
    const reply = await call(a.base, `/events/${id}`);
    if (id.includes("%00")) expectError(reply, 400); // a NUL byte can never be part of an address
    else expectError(reply, 404, ErrorCode.NOT_FOUND);
  });

  it("the same answer to a HEAD request (what `curl -I` sends)", async () => {
    for (const id of ["9999", "abc"]) {
      const res = await fetch(`${a.base}/events/${id}`, { method: "HEAD" });
      expect(res.status, id).toBe(404);
    }
    expect((await fetch(`${a.base}/events/1`, { method: "HEAD" })).status).toBe(200);
  });
});

describe("the two-level cache (acceptance checks 3 and 4)", () => {
  it("100 identical requests on a cold cache, spread over both instances, cause exactly ONE database query", async () => {
    const fresh = 41;
    resetCount();
    const replies = await Promise.all(Array.from({ length: 100 }, (_, i) => call(i % 2 ? a.base : b.base, `/events/${fresh}`)));
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(new Set(replies.map((reply) => reply.text)).size).toBe(1);
    expect(eventQueries()).toBe(1);
  });

  it("afterwards the answer comes without any query, from memory, in a few milliseconds", async () => {
    await eventOf(42); // warm
    resetCount();
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      await call(i % 2 ? a.base : b.base, "/events/42");
      times.push(performance.now() - started);
    }
    expect(eventQueries()).toBe(0);
    expect(times.sort((x, y) => x - y)[15]).toBeLessThan(15); // median
  });

  it("the second instance finds what the first one loaded in Redis and does not ask the database", async () => {
    await eventOf(43, a.base);
    resetCount();
    await eventOf(43, b.base);
    expect(eventQueries()).toBe(0);
  });

  it("'not found' is cached too: 50 requests for a missing event cost one query", async () => {
    resetCount();
    const replies = await Promise.all(Array.from({ length: 50 }, (_, i) => call(i % 2 ? a.base : b.base, "/events/9996")));
    expect(replies.every((reply) => reply.status === 404)).toBe(true);
    expect(eventQueries()).toBe(1);
  });

  it("'not found' is remembered only briefly: an event that appears is found within a few seconds", async () => {
    expect((await call(a.base, "/events/9998")).status).toBe(404);
    await sql.query(`INSERT INTO events (id, title, description, city, starts_at, hall_id) VALUES (9998, 'Late arrival', '', 'Sochi', now() + interval '5 days', 1)`);
    await new Promise((resolve) => setTimeout(resolve, 5500));
    expect((await call(a.base, "/events/9998")).status).toBe(200);
    expect((await call(b.base, "/events/9998")).status).toBe(200);
  }, 30_000);

  it("a change through one instance is seen through the other IMMEDIATELY - 25 times in a row, no waiting", async () => {
    const id = 50;
    let version = (await eventOf(id)).version;
    await eventOf(id, b.base); // the other instance now holds the old copy in memory and in Redis
    for (let round = 0; round < 25; round++) {
      const writer = round % 2 ? b : a;
      const reader = round % 2 ? a : b;
      const patch = await call(writer.base, `/events/${id}`, { method: "PATCH", cookie: admin, body: { title: `Round ${round}`, version } });
      expect(patch.status, patch.text).toBe(200);
      version = (patch.body as EventDto).version;
      const seen = await eventOf(id, reader.base);
      expect(seen.title, `round ${round}`).toBe(`Round ${round}`);
      expect(seen.version).toBe(version);
    }
  });

  it("lists change at once as well", async () => {
    const before = await listOf("/events?q=Hot%20title", b.base);
    expect(before.items).toEqual([]);
    const target = await eventOf(51);
    const patch = await call(a.base, "/events/51", { method: "PATCH", cookie: admin, body: { title: "Hot title", version: target.version } });
    expect(patch.status).toBe(200);
    expect((await listOf("/events?q=Hot%20title", b.base)).items.map((event) => event.id)).toEqual([51]);
  });

  it("a change made behind the api's back (plain SQL) shows up once the generation is bumped, which the worker does", async () => {
    const before = await eventOf(52);
    await sql.query(`UPDATE events SET title = 'Edited in SQL' WHERE id = 52`);
    expect((await eventOf(52)).title).toBe(before.title); // still the cached copy: this is the documented staleness
    await bump();
    expect((await eventOf(52, a.base)).title).toBe("Edited in SQL");
    expect((await eventOf(52, b.base)).title).toBe("Edited in SQL");
  });

  it("every change of an event leaves a note for the worker (written by the database, not by the api)", async () => {
    const event = await eventOf(53);
    await call(a.base, "/events/53", { method: "PATCH", cookie: admin, body: { title: "Noted", version: event.version } });
    const notes = await sql.query(`SELECT payload FROM outbox WHERE payload->>'eventId' = '53' ORDER BY id DESC LIMIT 1`);
    expect(notes.rows[0]?.payload).toMatchObject({ eventId: 53, version: event.version + 1, op: "UPDATE" });
  });
});

describe("PATCH /events/:id", () => {
  it("is for the administrator only: anonymous 401, an ordinary user 403", async () => {
    const event = await eventOf(60);
    const body = { title: "Hacked", version: event.version };
    expectError(await call(a.base, "/events/60", { method: "PATCH", body }), 401, ErrorCode.UNAUTHENTICATED);
    expectError(await call(a.base, "/events/60", { method: "PATCH", body, cookie: alice }), 403, ErrorCode.FORBIDDEN);
    expect((await eventOf(60)).title).toBe(event.title);
  });

  it("changes the title and the description, raises the version, and returns the saved event", async () => {
    const event = await eventOf(61);
    const reply = await call(a.base, "/events/61", { method: "PATCH", cookie: admin, body: { title: "  New title  ", description: "New description 🎭 <b>kept as typed</b>", version: event.version } });
    expect(reply.status).toBe(200);
    const saved = eventSchema.parse(reply.body);
    expect(saved).toMatchObject({ id: 61, title: "New title", description: "New description 🎭 <b>kept as typed</b>", version: event.version + 1 });
    expect(await eventOf(61, b.base)).toEqual(saved);
  });

  it("title alone and description alone both work, and the other field is left as it was", async () => {
    const event = await eventOf(62);
    const first = await call(a.base, "/events/62", { method: "PATCH", cookie: admin, body: { description: "Only text", version: event.version } });
    expect(first.body).toMatchObject({ title: event.title, description: "Only text" });
    const second = await call(a.base, "/events/62", { method: "PATCH", cookie: admin, body: { title: "Only title", version: (first.body as EventDto).version } });
    expect(second.body).toMatchObject({ title: "Only title", description: "Only text" });
  });

  it("a stale version is 409 VERSION_CONFLICT and the answer contains the event as it is saved now", async () => {
    const event = await eventOf(63);
    await call(a.base, "/events/63", { method: "PATCH", cookie: admin, body: { title: "First editor", version: event.version } });
    const late = await call(b.base, "/events/63", { method: "PATCH", cookie: admin, body: { title: "Second editor", version: event.version } });
    expectError(late, 409, ErrorCode.VERSION_CONFLICT);
    expect((late.body as { details: { current: EventDto } }).details.current).toMatchObject({ title: "First editor", version: event.version + 1 });
    expect((await eventOf(63)).title).toBe("First editor");
  });

  it("20 administrators save the same version at the same moment: exactly one wins, 19 get 409", async () => {
    const event = await eventOf(64);
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) => call(i % 2 ? a.base : b.base, "/events/64", { method: "PATCH", cookie: admin, body: { title: `Editor ${i}`, version: event.version } })),
    );
    const winners = replies.filter((reply) => reply.status === 200);
    expect(winners).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 409)).toHaveLength(19);
    const final = await eventOf(64);
    expect(final.version).toBe(event.version + 1);
    expect(final.title).toBe((winners[0]?.body as EventDto).title);
  });

  it("each save returns the version for the next one", async () => {
    let version = (await eventOf(65)).version;
    for (let i = 0; i < 4; i++) {
      const reply = await call(a.base, "/events/65", { method: "PATCH", cookie: admin, body: { title: `Step ${i}`, version } });
      expect(reply.status).toBe(200);
      expect((reply.body as EventDto).version).toBe(version + 1);
      version += 1;
    }
  });

  it("saving the same text again changes nothing (the version stays)", async () => {
    const event = await eventOf(66);
    const reply = await call(a.base, "/events/66", { method: "PATCH", cookie: admin, body: { title: event.title, version: event.version } });
    expect(reply.status).toBe(200);
    expect((reply.body as EventDto).version).toBe(event.version);
  });

  const badBodies: Array<[string, unknown]> = [
    ["no version", { title: "x" }],
    ["version as text", { title: "x", version: "1" }],
    ["version 0", { title: "x", version: 0 }],
    ["version negative", { title: "x", version: -1 }],
    ["version fractional", { title: "x", version: 1.5 }],
    ["version too big", { title: "x", version: 2147483648 }],
    ["nothing to change", { version: 1 }],
    ["empty title", { title: "", version: 1 }],
    ["blank title", { title: "    ", version: 1 }],
    ["title of 201 characters", { title: "t".repeat(201), version: 1 }],
    ["description of 5001 characters", { description: "d".repeat(5001), version: 1 }],
    ["title is a number", { title: 5, version: 1 }],
    ["title is an object", { title: { $set: "x" }, version: 1 }],
    ["a field that may not be changed", { title: "x", city: "Paris", version: 1 }],
    ["the version field forged inside", { title: "x", version: 1, id: 7 }],
    ["NUL byte in the title", { title: "bad\u0000title", version: 1 }],
    ["NUL byte in the description", { description: "bad\u0000text", version: 1 }],
    ["array body", [{ title: "x", version: 1 }]],
  ];
  it.each(badBodies)("%s: 400, and the event is untouched", async (_name, body) => {
    const before = await eventOf(67);
    expectError(await call(a.base, "/events/67", { method: "PATCH", cookie: admin, body }), 400, ErrorCode.VALIDATION_ERROR);
    expect(await eventOf(67)).toEqual(before);
  });

  it("an unknown or malformed id is 404 for the administrator, and the check for the role comes first", async () => {
    const body = { title: "x", version: 1 };
    expectError(await call(a.base, "/events/9997", { method: "PATCH", cookie: admin, body }), 404, ErrorCode.NOT_FOUND);
    expectError(await call(a.base, "/events/abc", { method: "PATCH", cookie: admin, body }), 404, ErrorCode.NOT_FOUND);
    expectError(await call(a.base, "/events/abc", { method: "PATCH", cookie: alice, body }), 403, ErrorCode.FORBIDDEN);
  });
});
