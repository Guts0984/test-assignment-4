import { randomUUID } from "node:crypto";
import { holdSchema, seatMapSchema, seatsChangedSchema, SOCKET_EVENTS, type SeatMap, type SeatsChanged } from "@app/shared";
import { Client } from "pg";
import { io as connectClient, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WatchAck } from "../src/realtime/realtime";
import { SessionStore } from "../src/auth/session";
import { call, startApp, type TestApp } from "./helpers";

// Real Socket.IO clients against two real api instances that share Redis (the Redis adapter carries the messages).
let a: TestApp;
let b: TestApp;
let sql: Client;
let sessions: SessionStore;
const NO_LIMIT = { RATE_LIMIT_MAX: "1000000" };
const open: Socket[] = [];
let nextEvent = 40;

beforeAll(async () => {
  a = await startApp({ env: NO_LIMIT });
  b = await startApp({ env: NO_LIMIT, databaseUrl: a.databaseUrl, flush: false });
  sql = new Client({ connectionString: a.databaseUrl });
  await sql.connect();
  sessions = new SessionStore(a.infra.redis, 3600);
});
afterAll(async () => {
  for (const socket of open) socket.disconnect();
  await sql.end();
  await Promise.all([a.close(), b.close()]);
});

type Person = { id: string; cookie: string };
async function person(): Promise<Person> {
  const email = `rt${randomUUID().slice(0, 8)}@test.local`;
  const created = await sql.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email]);
  const id = created.rows[0]?.id as string;
  return { id, cookie: `sid=${await sessions.create({ userId: id, email, role: "user" })}` };
}
const freshEvent = () => ++nextEvent;
async function seatsOf(eventId: number, count: number): Promise<number[]> {
  const result = await sql.query<{ id: number }>(`SELECT s.id FROM seats s JOIN events e ON e.hall_id = s.hall_id WHERE e.id = $1 ORDER BY s.id LIMIT $2`, [eventId, count]);
  return result.rows.map((row) => row.id);
}

function connect(instance: TestApp, cookie?: string, extraHeaders: Record<string, string> = {}): Promise<Socket> {
  const socket = connectClient(instance.base, { transports: ["websocket"], reconnection: false, extraHeaders: { ...(cookie ? { cookie } : {}), ...extraHeaders } });
  open.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

const watch = (socket: Socket, eventId: unknown): Promise<WatchAck> => socket.timeout(5000).emitWithAck(SOCKET_EVENTS.watch, { eventId });

/** Collects the seat messages a socket receives, from now on. */
function listen(socket: Socket): { messages: SeatsChanged[]; next: (match: (m: SeatsChanged) => boolean, ms?: number) => Promise<SeatsChanged> } {
  const messages: SeatsChanged[] = [];
  const waiting: Array<{ match: (m: SeatsChanged) => boolean; resolve: (m: SeatsChanged) => void }> = [];
  socket.on(SOCKET_EVENTS.seatsChanged, (raw: unknown) => {
    const message = seatsChangedSchema.parse(raw);
    messages.push(message);
    for (const w of [...waiting]) {
      if (!w.match(message)) continue;
      waiting.splice(waiting.indexOf(w), 1);
      w.resolve(message);
    }
  });
  return {
    messages,
    next: (match, ms = 3000) =>
      new Promise((resolve, reject) => {
        const found = messages.find(match);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`no matching seat message within ${ms} ms; got ${JSON.stringify(messages)}`)), ms);
        waiting.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      }),
  };
}

const hold = (who: Person, eventId: number, seatIds: number[], instance: TestApp = a) =>
  call(instance.base, `/events/${eventId}/holds`, { cookie: who.cookie, body: { seatIds }, headers: { "idempotency-key": `key-${randomUUID()}` } });
const cellOf = (map: SeatMap, seatId: number) => map.rows.flatMap((row) => row.seats).find((seat) => seat.id === seatId);
const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("watching a hall", () => {
  it("answers 'watch' with the full current map - own seats marked for a logged-in visitor, never for an anonymous one", async () => {
    const eventId = freshEvent();
    const [alice, seatIds] = [await person(), await seatsOf(eventId, 3)];
    await hold(alice, eventId, [seatIds[0] as number]);

    const asAlice = await watch(await connect(b, alice.cookie), eventId);
    const asNobody = await watch(await connect(a), eventId);
    const asBadCookie = await watch(await connect(a, "sid=" + "A".repeat(43)), eventId);
    for (const reply of [asAlice, asNobody, asBadCookie]) expect(reply.ok).toBe(true);
    const mapFor = (reply: WatchAck) => seatMapSchema.parse(reply.ok ? reply.map : null);
    expect(cellOf(mapFor(asAlice), seatIds[0] as number)).toMatchObject({ status: "held", mine: true });
    expect(cellOf(mapFor(asNobody), seatIds[0] as number)).toMatchObject({ status: "held", mine: false });
    expect(cellOf(mapFor(asBadCookie), seatIds[0] as number)).toMatchObject({ status: "held", mine: false });
    expect(JSON.stringify(asNobody)).not.toContain(alice.id); // no anonymous visitor learns who holds a seat
  });

  it("rejects nonsense and unknown events without crashing", async () => {
    const socket = await connect(a);
    for (const bad of [undefined, null, "5", 0, -1, 1.5, "abc", 2 ** 40, {}, [], { eventId: "1; DROP TABLE seats" }]) {
      const reply = await socket.timeout(5000).emitWithAck(SOCKET_EVENTS.watch, bad);
      expect(reply, JSON.stringify(bad)).toEqual({ ok: false, error: "invalid" });
    }
    expect(await watch(socket, 9999)).toEqual({ ok: false, error: "not_found" });
    expect((await call(a.base, "/health")).status).toBe(200);
  });

  it("limits how many halls one connection can watch at once", async () => {
    const socket = await connect(a);
    for (let i = 0; i < 5; i++) expect((await watch(socket, freshEvent())).ok).toBe(true);
    expect(await watch(socket, freshEvent())).toEqual({ ok: false, error: "too_many" });
  });
});

describe("changes reach everybody who watches, on either instance (acceptance check 9, realtime part)", () => {
  it("held, released and sold seats are announced to three clients on two instances", async () => {
    const eventId = freshEvent();
    const [alice, bob] = [await person(), await person()];
    const [seatId, otherSeat] = await seatsOf(eventId, 2);
    const onA = await connect(a, alice.cookie);
    const onB = await connect(b, bob.cookie);
    const anonymous = await connect(a);
    const clients = [onA, onB, anonymous].map((socket) => listen(socket));
    for (const socket of [onA, onB, anonymous]) expect((await watch(socket, eventId)).ok).toBe(true);

    // alice holds on instance A -> all three hear it, including the one on instance B
    const created = await hold(alice, eventId, [seatId as number, otherSeat as number], a);
    expect(created.status).toBe(201);
    for (const client of clients) {
      const message = await client.next((m) => m.changes.some((c) => c.seatId === seatId));
      expect(message.eventId).toBe(eventId);
      expect(message.changes).toEqual(expect.arrayContaining([{ seatId, status: "held" }, { seatId: otherSeat, status: "held" }]));
    }

    // she cancels through instance B -> all three hear "free"
    const holdId = holdSchema.parse((created.body as { hold: unknown }).hold).id;
    expect((await call(b.base, `/holds/${holdId}`, { method: "DELETE", cookie: alice.cookie })).status).toBe(204);
    for (const client of clients) {
      const message = await client.next((m) => m.changes.some((c) => c.seatId === seatId && c.status === "free"));
      expect(message.changes).toEqual(expect.arrayContaining([{ seatId, status: "free" }]));
    }

    // bob holds and pays -> "held", then "sold"
    const bobsHold = holdSchema.parse(((await hold(bob, eventId, [seatId as number], b)).body as { hold: unknown }).hold);
    await call(a.base, `/holds/${bobsHold.id}/pay`, { method: "POST", cookie: bob.cookie });
    for (const client of clients) await client.next((m) => m.changes.some((c) => c.seatId === seatId && c.status === "sold"));
  });

  it("messages say WHAT changed, never WHO: only event id, seat ids and statuses", async () => {
    const eventId = freshEvent();
    const alice = await person();
    const [seatId] = await seatsOf(eventId, 1);
    const watcher = await connect(b);
    const heard = listen(watcher);
    await watch(watcher, eventId);
    await hold(alice, eventId, [seatId as number]);
    await heard.next((m) => m.changes.length > 0);
    const text = JSON.stringify(heard.messages);
    expect(text).not.toContain(alice.id);
    expect(Object.keys(heard.messages[0] ?? {}).sort()).toEqual(["changes", "eventId"]);
  });

  it("only the watchers of THAT event hear about it", async () => {
    const [watchedEvent, otherEvent] = [freshEvent(), freshEvent()];
    const alice = await person();
    const watcher = await connect(a);
    const other = await connect(b);
    const heardByWatcher = listen(watcher);
    const heardByOther = listen(other);
    await watch(watcher, watchedEvent);
    await watch(other, otherEvent);
    await hold(alice, watchedEvent, (await seatsOf(watchedEvent, 1)));
    await heardByWatcher.next((m) => m.eventId === watchedEvent);
    await quiet(500);
    expect(heardByOther.messages).toEqual([]);
  });

  it("after 'unwatch' the client hears nothing more", async () => {
    const eventId = freshEvent();
    const alice = await person();
    const socket = await connect(a);
    const heard = listen(socket);
    await watch(socket, eventId);
    socket.emit(SOCKET_EVENTS.unwatch, { eventId });
    await quiet(300);
    await hold(alice, eventId, await seatsOf(eventId, 1));
    await quiet(600);
    expect(heard.messages).toEqual([]);
  });

  it("a request that was refused changes nothing, so nothing is announced", async () => {
    const eventId = freshEvent();
    const [alice, bob] = [await person(), await person()];
    const [seatId] = await seatsOf(eventId, 1);
    const socket = await connect(b);
    const heard = listen(socket);
    await watch(socket, eventId);
    await hold(alice, eventId, [seatId as number]);
    await heard.next((m) => m.changes.length > 0);
    const before = heard.messages.length;
    expect((await hold(bob, eventId, [seatId as number])).status).toBe(409);
    await quiet(600);
    expect(heard.messages.length).toBe(before);
  });
});

describe("a client that was away gets the current state back (acceptance: reconnect)", () => {
  it("a new connection asks again and receives everything that happened meanwhile", async () => {
    const eventId = freshEvent();
    const [alice, bob] = [await person(), await person()];
    const seatIds = await seatsOf(eventId, 4);
    const watcher = await connect(b, bob.cookie);
    await watch(watcher, eventId);
    watcher.disconnect(); // the connection drops ...
    await hold(alice, eventId, [seatIds[0] as number, seatIds[1] as number]); // ... while the hall changes ...
    const created = await hold(alice, eventId, [seatIds[2] as number]);
    await call(a.base, `/holds/${holdSchema.parse((created.body as { hold: unknown }).hold).id}/pay`, { method: "POST", cookie: alice.cookie });

    const again = await connect(b, bob.cookie); // ... and it comes back
    const reply = await watch(again, eventId);
    const map = seatMapSchema.parse(reply.ok ? reply.map : null);
    expect([0, 1, 2, 3].map((i) => cellOf(map, seatIds[i] as number)?.status)).toEqual(["held", "held", "sold", "free"]);
  });

  it("also when the server side closes the connection: the client library's automatic reconnect + watch gives the full state", async () => {
    const eventId = freshEvent();
    const alice = await person();
    const [seatId] = await seatsOf(eventId, 1);
    const socket = connectClient(b.base, { transports: ["websocket"], reconnection: true, reconnectionDelay: 50, extraHeaders: { cookie: alice.cookie } });
    open.push(socket);
    let latest: SeatMap | null = null;
    // what the web page does: on EVERY (re)connect, ask for the whole map again
    socket.on("connect", () => {
      void watch(socket, eventId).then((reply) => {
        if (reply.ok) latest = reply.map;
      });
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    await quiet(300);
    socket.io.engine.close(); // the network drops
    await hold(alice, eventId, [seatId as number]);
    for (let i = 0; i < 50 && (latest === null || cellOf(latest, seatId as number)?.status !== "held"); i++) await quiet(100);
    expect(latest && cellOf(latest, seatId as number)).toMatchObject({ status: "held", mine: true });
  });
});

describe("who may connect", () => {
  it("a page of another website cannot open a connection with the visitor's cookies (wrong Origin)", async () => {
    await expect(connect(a, undefined, { origin: "https://evil.example" })).rejects.toThrow();
    const hostMatches = new URL(a.base).host;
    await expect(connect(a, undefined, { origin: `http://${hostMatches}` })).resolves.toBeDefined();
  });

  it("long-polling is not offered (WebSocket only)", async () => {
    const socket = connectClient(a.base, { transports: ["polling"], reconnection: false });
    open.push(socket);
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", reject);
      }),
    ).rejects.toThrow();
  });

  it("a flood of garbage messages does not hurt the server", async () => {
    const socket = await connect(a);
    for (let i = 0; i < 200; i++) socket.emit(SOCKET_EVENTS.watch, { eventId: "x".repeat(1000) + i });
    socket.emit("no-such-event", { a: 1 });
    await quiet(300);
    expect((await call(a.base, "/ready")).status).toBe(200);
    expect((await watch(socket, freshEvent())).ok).toBe(true);
  });
});
