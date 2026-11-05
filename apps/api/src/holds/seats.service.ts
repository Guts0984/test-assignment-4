import {
  ErrorCode,
  MAX_SEATS_PER_USER,
  type HoldDto,
  type HoldStatus,
  type OrderDto,
  type OrderList,
  type SeatMap,
  type SeatsChanged,
} from "@app/shared";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EventsService } from "../events/events.service";
import { AppError, notFound } from "../http/errors";
import { Infra } from "../infra/infra";
import { Realtime } from "../realtime/realtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SeatRow = { seat_id: number; row: string; number: number; status: "FREE" | "HELD" | "SOLD"; user_id: string | null; hold_id: string | null; held: boolean };
type SeatRefRow = { id: number; row: string; number: number };
type HoldRow = { id: string; user_id: string; event_id: number; status: "ACTIVE" | "PAID" | "CANCELLED" | "EXPIRED"; expires_at: Date };

/** Decides which seats of a hold or order belong to which, in the order of the hall. */
const byPlace = (a: SeatRefRow, b: SeatRefRow): number => a.row.localeCompare(b.row) || a.number - b.number;

@Injectable()
export class SeatsService {
  /** Requests for the same map that arrive while one is already being read share that one read (nothing is kept afterwards). */
  private readonly mapReads = new Map<number, Promise<SeatRow[]>>();

  constructor(
    @Inject(Infra) private readonly infra: Infra,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(Realtime) private readonly realtime: Realtime,
  ) {}

  // ---------------------------------------------------------------- reading

  /**
   * The state of every seat of an event. NOT cached: it is read from the database, and only requests that overlap in
   * time share one read - the assignment allows at most 1 second of staleness for seat state, and we keep none.
   * A hold whose time is up counts as free at once, without waiting for the worker to tidy up.
   */
  async seatMap(eventId: number, userId: string | undefined): Promise<SeatMap> {
    if (!(await this.events.getEvent(eventId))) throw notFound("Event not found");
    let read = this.mapReads.get(eventId);
    if (!read) {
      read = this.infra.db.$queryRaw<SeatRow[]>`
        SELECT s.id AS seat_id, s."row" AS row, s.number, es.status::text AS status, es.user_id, es.hold_id,
               (es.status = 'HELD' AND es.held_until > now()) AS held
        FROM event_seats es JOIN seats s ON s.id = es.seat_id
        WHERE es.event_id = ${eventId}
        ORDER BY s."row", s.number`.finally(() => this.mapReads.delete(eventId));
      this.mapReads.set(eventId, read);
    }
    const rows = await read;
    const grouped = new Map<string, SeatMap["rows"][number]["seats"]>();
    const myHoldIds = new Set<string>();
    for (const seat of rows) {
      const status = seat.status === "SOLD" ? "sold" : seat.status === "HELD" && seat.held ? "held" : "free";
      const cells = grouped.get(seat.row) ?? [];
      const mine = userId !== undefined && status !== "free" && seat.user_id === userId;
      if (mine && status === "held" && seat.hold_id) myHoldIds.add(seat.hold_id);
      cells.push({ id: seat.seat_id, number: seat.number, status, mine });
      grouped.set(seat.row, cells);
    }
    return { eventId, rows: [...grouped].map(([label, seats]) => ({ label, seats })), myHoldIds: [...myHoldIds] };
  }

  // ---------------------------------------------------------------- holding

  /**
   * Holds seats for the user for HOLD_TTL_SECONDS, all or nothing, in one transaction.
   * Who gets a contested seat is decided by the database: the seats are locked in a fixed order (no deadlocks) and taken
   * with "UPDATE ... WHERE free or expired". The 6-seats-per-user rule is enforced by a database trigger.
   */
  async createHold(userId: string, eventId: number, seatIds: number[]): Promise<HoldDto> {
    const event = await this.events.getEvent(eventId);
    if (!event) throw notFound("Event not found");
    if (Date.parse(event.startsAt) <= Date.now()) {
      throw new AppError(409, ErrorCode.EVENT_STARTED, "This event has already started.");
    }
    const ttl = this.infra.env.HOLD_TTL_SECONDS;
    const holdId = randomUUID();
    try {
      await this.infra.db.$transaction(
        async (tx) => {
          await tx.$executeRaw`INSERT INTO holds (id, user_id, event_id, expires_at)
                               VALUES (${holdId}::uuid, ${userId}::uuid, ${eventId}, now() + make_interval(secs => ${ttl}))`;
          const locked = await tx.$queryRaw<{ id: number }[]>`
            SELECT id FROM event_seats WHERE event_id = ${eventId} AND seat_id = ANY(${seatIds}::int[]) ORDER BY id FOR UPDATE`;
          if (locked.length !== seatIds.length) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Some of these seats do not exist in this hall.", { fields: { seatIds: ["Unknown seat for this event."] } });
          }
          const taken = await tx.$executeRaw`
            UPDATE event_seats
            SET status = 'HELD', user_id = ${userId}::uuid, hold_id = ${holdId}::uuid,
                held_until = (SELECT expires_at FROM holds WHERE id = ${holdId}::uuid)
            WHERE event_id = ${eventId} AND seat_id = ANY(${seatIds}::int[])
              AND (status = 'FREE' OR (status = 'HELD' AND held_until <= now()))`;
          if (taken !== seatIds.length) {
            const unavailable = await tx.$queryRaw<{ seat_id: number }[]>`
              SELECT seat_id FROM event_seats
              WHERE event_id = ${eventId} AND seat_id = ANY(${seatIds}::int[])
                AND NOT (status = 'FREE' OR (status = 'HELD' AND held_until <= now()))
                AND hold_id IS DISTINCT FROM ${holdId}::uuid
              ORDER BY seat_id`;
            throw new AppError(409, ErrorCode.SOLD_OUT, "Some of these seats were just taken by someone else.", { seatIds: unavailable.map((row) => row.seat_id) });
          }
        },
        { timeout: 8000, maxWait: 3000 },
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("seat_limit_exceeded")) {
        throw new AppError(409, ErrorCode.SEAT_LIMIT_REACHED, `You can have at most ${MAX_SEATS_PER_USER} seats for one event (held and bought together).`, { limit: MAX_SEATS_PER_USER });
      }
      throw error;
    }
    this.announce(eventId, seatIds.map((seatId) => ({ seatId, status: "held" as const })));
    return this.readHold(userId, holdId);
  }

  // ---------------------------------------------------------------- reading one hold

  async readHold(userId: string, holdId: string): Promise<HoldDto> {
    if (!UUID.test(holdId)) throw notFound("Booking not found");
    const holds = await this.infra.db.$queryRaw<(HoldRow & { title: string; city: string; starts_at: Date })[]>`
      SELECT h.id, h.user_id, h.event_id, h.status::text AS status, h.expires_at, e.title, e.city, e.starts_at
      FROM holds h JOIN events e ON e.id = h.event_id WHERE h.id = ${holdId}::uuid`;
    const hold = holds[0];
    // Somebody else's hold looks exactly like one that does not exist.
    if (!hold || hold.user_id !== userId) throw notFound("Booking not found");
    const seats = await this.infra.db.$queryRaw<SeatRefRow[]>`
      SELECT s.id, s."row" AS row, s.number FROM event_seats es JOIN seats s ON s.id = es.seat_id
      WHERE es.hold_id = ${holdId}::uuid
      UNION ALL
      SELECT s.id, s."row", s.number FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN event_seats es ON es.event_id = oi.event_id AND es.seat_id = oi.seat_id
        JOIN seats s ON s.id = oi.seat_id WHERE o.hold_id = ${holdId}::uuid`;
    const expired = hold.status === "ACTIVE" && hold.expires_at.getTime() <= Date.now();
    const status: HoldStatus = expired ? "expired" : (hold.status.toLowerCase() as HoldStatus);
    return {
      id: hold.id,
      eventId: hold.event_id,
      status,
      seats: seats.sort(byPlace),
      expiresAt: hold.expires_at.toISOString(),
      event: { id: hold.event_id, title: hold.title, city: hold.city, startsAt: hold.starts_at.toISOString() },
    };
  }

  // ---------------------------------------------------------------- cancelling

  /** Gives the seats back. Cancelling twice, or after the time ran out, is fine; cancelling a paid booking is not. */
  async cancelHold(userId: string, holdId: string): Promise<void> {
    if (!UUID.test(holdId)) throw notFound("Booking not found");
    const freed = await this.infra.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<HoldRow[]>`SELECT id, user_id, event_id, status::text AS status, expires_at FROM holds WHERE id = ${holdId}::uuid FOR UPDATE`;
        const hold = rows[0];
        if (!hold || hold.user_id !== userId) throw notFound("Booking not found");
        if (hold.status === "PAID") throw new AppError(409, ErrorCode.ALREADY_PAID, "This booking is already paid.");
        if (hold.status !== "ACTIVE") return { eventId: hold.event_id, seatIds: [] as number[] };
        await tx.$executeRaw`UPDATE holds SET status = 'CANCELLED' WHERE id = ${holdId}::uuid`;
        const seats = await tx.$queryRaw<{ seat_id: number }[]>`
          UPDATE event_seats SET status = 'FREE', user_id = NULL, hold_id = NULL, held_until = NULL
          WHERE hold_id = ${holdId}::uuid AND status = 'HELD' RETURNING seat_id`;
        return { eventId: hold.event_id, seatIds: seats.map((seat) => seat.seat_id) };
      },
      { timeout: 8000, maxWait: 3000 },
    );
    this.announce(freed.eventId, freed.seatIds.map((seatId) => ({ seatId, status: "free" as const })));
  }

  // ---------------------------------------------------------------- paying (the stub)

  /** The stub payment always succeeds - if the hold is still valid. The hold becomes an order and its seats are sold. */
  async payHold(userId: string, holdId: string): Promise<OrderDto> {
    if (!UUID.test(holdId)) throw notFound("Booking not found");
    const outcome = await this.infra.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<HoldRow[]>`SELECT id, user_id, event_id, status::text AS status, expires_at FROM holds WHERE id = ${holdId}::uuid FOR UPDATE`;
        const hold = rows[0];
        if (!hold || hold.user_id !== userId) throw notFound("Booking not found");
        if (hold.status === "PAID") {
          const existing = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE hold_id = ${holdId}::uuid`;
          return { kind: "paid" as const, orderId: existing[0]?.id as string, eventId: hold.event_id, seatIds: [] as number[] };
        }
        if (hold.status === "CANCELLED") throw new AppError(409, ErrorCode.BOOKING_CANCELLED, "This booking was cancelled.");

        const seats = await tx.$queryRaw<{ seat_id: number }[]>`
          SELECT seat_id FROM event_seats WHERE hold_id = ${holdId}::uuid AND status = 'HELD' ORDER BY id FOR UPDATE`;
        const timeIsUp = hold.status === "EXPIRED" || hold.expires_at.getTime() <= Date.now();
        if (timeIsUp || seats.length === 0) {
          // Release what is left of it (the worker would do the same a moment later) and say so.
          await tx.$executeRaw`UPDATE holds SET status = 'EXPIRED' WHERE id = ${holdId}::uuid AND status = 'ACTIVE'`;
          const freed = await tx.$queryRaw<{ seat_id: number }[]>`
            UPDATE event_seats SET status = 'FREE', user_id = NULL, hold_id = NULL, held_until = NULL
            WHERE hold_id = ${holdId}::uuid AND status = 'HELD' RETURNING seat_id`;
          return { kind: "expired" as const, orderId: "", eventId: hold.event_id, seatIds: freed.map((seat) => seat.seat_id) };
        }

        await tx.$executeRaw`UPDATE event_seats SET status = 'SOLD', hold_id = NULL, held_until = NULL WHERE hold_id = ${holdId}::uuid AND status = 'HELD'`;
        const order = await tx.$queryRaw<{ id: string }[]>`INSERT INTO orders (user_id, event_id, hold_id) VALUES (${userId}::uuid, ${hold.event_id}, ${holdId}::uuid) RETURNING id`;
        const orderId = order[0]?.id as string;
        const seatIds = seats.map((seat) => seat.seat_id);
        await tx.$executeRaw`INSERT INTO order_items (order_id, event_id, seat_id) SELECT ${orderId}::uuid, ${hold.event_id}, unnest(${seatIds}::int[])`;
        await tx.$executeRaw`UPDATE holds SET status = 'PAID' WHERE id = ${holdId}::uuid`;
        return { kind: "sold" as const, orderId, eventId: hold.event_id, seatIds };
      },
      { timeout: 8000, maxWait: 3000 },
    );
    if (outcome.kind === "expired") {
      this.announce(outcome.eventId, outcome.seatIds.map((seatId) => ({ seatId, status: "free" as const })));
      throw new AppError(409, ErrorCode.BOOKING_EXPIRED, "The time to pay ran out and the seats were released.");
    }
    if (outcome.kind === "sold") this.announce(outcome.eventId, outcome.seatIds.map((seatId) => ({ seatId, status: "sold" as const })));
    return this.readOrder(userId, outcome.orderId);
  }

  // ---------------------------------------------------------------- orders

  async readOrder(userId: string, orderId: string): Promise<OrderDto> {
    const orders = await this.listOrders(userId, orderId);
    const order = orders.items[0];
    if (!order) throw notFound("Order not found");
    return order;
  }

  /** The user's orders, newest first. Only ever the caller's own. */
  async listOrders(userId: string, onlyOrderId?: string): Promise<OrderList> {
    const orders = await this.infra.db.$queryRaw<{ id: string; event_id: number; created_at: Date; title: string; city: string; starts_at: Date }[]>`
      SELECT o.id, o.event_id, o.created_at, e.title, e.city, e.starts_at
      FROM orders o JOIN events e ON e.id = o.event_id
      WHERE o.user_id = ${userId}::uuid AND (${onlyOrderId ?? null}::uuid IS NULL OR o.id = ${onlyOrderId ?? null}::uuid)
      ORDER BY o.created_at DESC, o.id LIMIT 100`;
    if (orders.length === 0) return { items: [] };
    const ids = orders.map((order) => order.id);
    const items = await this.infra.db.$queryRaw<(SeatRefRow & { order_id: string })[]>`
      SELECT oi.order_id, s.id, s."row" AS row, s.number
      FROM order_items oi JOIN seats s ON s.id = oi.seat_id WHERE oi.order_id = ANY(${ids}::uuid[])`;
    return {
      items: orders.map((order) => ({
        id: order.id,
        eventId: order.event_id,
        event: { id: order.event_id, title: order.title, city: order.city, startsAt: order.starts_at.toISOString() },
        seats: items.filter((item) => item.order_id === order.id).map(({ id, row, number }) => ({ id, row, number })).sort(byPlace),
        createdAt: order.created_at.toISOString(),
      })),
    };
  }

  // ---------------------------------------------------------------- telling watchers

  private announce(eventId: number, changes: SeatsChanged["changes"]): void {
    if (changes.length > 0) this.realtime.seatsChanged(eventId, changes);
  }
}
