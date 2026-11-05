import { createAdapter } from "@socket.io/redis-adapter";
import { SOCKET_EVENTS, seatRoom, watchRequestSchema, type SeatMap, type SeatsChanged } from "@app/shared";
import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { readCookie, SESSION_COOKIE, type SessionData, type SessionStore } from "../auth/session";
import type { Infra } from "../infra/infra";

export type WatchAck = { ok: true; map: SeatMap } | { ok: false; error: "invalid" | "not_found" | "unavailable" | "too_many" };

type ReadMap = (eventId: number, userId: string | undefined) => Promise<SeatMap>;

const MAX_WATCHED_EVENTS_PER_SOCKET = 5;

/**
 * Live seat changes over Socket.IO.
 * - WebSocket only (no long-polling), so no "sticky" routing is needed behind nginx with two api instances.
 * - The Redis adapter carries every message to the watchers connected to ANY instance.
 * - A connection is tied to the same session cookie as the HTTP requests. Without a session you can watch the map,
 *   but you never get anything that belongs to a user.
 * - Only seat statuses are sent ("seat 12 is held"), never who holds a seat.
 */
export class Realtime {
  private io: Server | null = null;

  constructor(private readonly infra: Infra) {}

  start(httpServer: HttpServer, sessions: SessionStore, readMap: ReadMap): void {
    const { logger, redis } = this.infra;
    const io = new Server(httpServer, {
      path: "/socket.io",
      transports: ["websocket"],
      serveClient: false,
      maxHttpBufferSize: 10_000,
      pingInterval: 10_000,
      pingTimeout: 8_000,
      // A page of another site must not be able to open a connection with the visitor's cookies.
      allowRequest: (req, callback) => {
        const origin = req.headers.origin;
        if (!origin) return callback(null, true);
        try {
          callback(null, new URL(origin).host === req.headers.host);
        } catch {
          callback(null, false);
        }
      },
    });

    // The adapter needs its own two connections, which wait quietly while Redis is away and come back by themselves.
    const sharedOptions = { enableOfflineQueue: true, maxRetriesPerRequest: null, commandTimeout: undefined } as const;
    const pub = redis.duplicate(sharedOptions);
    const sub = redis.duplicate(sharedOptions);
    for (const client of [pub, sub]) client.on("error", (error) => logger.warn({ err: error.message }, "socket.io redis error"));
    io.adapter(createAdapter(pub, sub));
    this.closers.push(() => void pub.disconnect(), () => void sub.disconnect());

    io.use((socket, next) => {
      const id = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      if (!id) {
        socket.data["session"] = null;
        next();
        return;
      }
      sessions.get(id).then(
        (session) => {
          socket.data["session"] = session;
          next();
        },
        (error: unknown) => {
          logger.warn({ err: error instanceof Error ? error.message : String(error) }, "socket session lookup failed, continuing as anonymous");
          socket.data["session"] = null;
          next();
        },
      );
    });

    io.on("connection", (socket: Socket) => {
      const session = socket.data["session"] as SessionData | null;
      socket.on(SOCKET_EVENTS.watch, (payload: unknown, ack?: (reply: WatchAck) => void) => {
        const reply = typeof ack === "function" ? ack : () => undefined;
        const parsed = watchRequestSchema.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, error: "invalid" });
        const room = seatRoom(parsed.data.eventId);
        const watching = [...socket.rooms].filter((name) => name.startsWith("event:"));
        if (!socket.rooms.has(room) && watching.length >= MAX_WATCHED_EVENTS_PER_SOCKET) return reply({ ok: false, error: "too_many" });
        // Join first, read after: a change that happens in between is then in the map or arrives as a message, never lost.
        void Promise.resolve(socket.join(room))
          .then(() => readMap(parsed.data.eventId, session?.userId))
          .then(
            (map) => reply({ ok: true, map }),
            (error: unknown) => {
              void socket.leave(room);
              const notFound = typeof error === "object" && error !== null && (error as { status?: number }).status === 404;
              reply({ ok: false, error: notFound ? "not_found" : "unavailable" });
            },
          );
      });
      socket.on(SOCKET_EVENTS.unwatch, (payload: unknown) => {
        const parsed = watchRequestSchema.safeParse(payload);
        if (parsed.success) void socket.leave(seatRoom(parsed.data.eventId));
      });
    });
    this.io = io;
  }

  private readonly closers: Array<() => void> = [];

  /** Tells everybody watching this event that these seats changed. Never throws: a failed announcement must not fail the request. */
  seatsChanged(eventId: number, changes: SeatsChanged["changes"]): void {
    try {
      const payload: SeatsChanged = { eventId, changes };
      this.io?.to(seatRoom(eventId)).emit(SOCKET_EVENTS.seatsChanged, payload);
    } catch (error) {
      this.infra.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "could not announce seat change");
    }
  }

  async close(): Promise<void> {
    const io = this.io;
    this.io = null;
    if (io) await new Promise<void>((resolve) => void io.close(() => resolve()));
    for (const close of this.closers.splice(0)) close();
  }
}
