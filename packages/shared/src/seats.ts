import { z } from "zod";
import { eventSchema } from "./events";

/** At most this many seats per user per event (held and bought together). */
export const MAX_SEATS_PER_USER = 6;

export const seatStatusSchema = z.enum(["free", "held", "sold"]);
export type SeatStatus = z.infer<typeof seatStatusSchema>;

export const seatCellSchema = z.object({
  id: z.number().int(),
  number: z.number().int(),
  status: seatStatusSchema,
  /** True when the seat is held or bought by the user who asked. Never true for an anonymous visitor. */
  mine: z.boolean(),
});
export type SeatCell = z.infer<typeof seatCellSchema>;

/** The hall of one event: rows from the stage back, each with its seats. */
export const seatMapSchema = z.object({
  eventId: z.number().int(),
  rows: z.array(z.object({ label: z.string(), seats: z.array(seatCellSchema) })),
});
export type SeatMap = z.infer<typeof seatMapSchema>;

// ---------- holds ----------

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, "Use 8 to 128 letters, digits and . _ : -");

export const createHoldBodySchema = z.strictObject({
  seatIds: z
    .array(z.number().int().min(1).max(2_147_483_647))
    .min(1, "Choose at least one seat")
    // More than 6 is refused with a clear 409 (SEAT_LIMIT_REACHED); this bound only keeps the request small.
    .max(12)
    .refine((ids) => new Set(ids).size === ids.length, "A seat can be chosen only once"),
});
export type CreateHoldBody = z.infer<typeof createHoldBodySchema>;

export const holdStatusSchema = z.enum(["active", "paid", "cancelled", "expired"]);
export type HoldStatus = z.infer<typeof holdStatusSchema>;

export const seatRefSchema = z.object({ id: z.number().int(), row: z.string(), number: z.number().int() });
export type SeatRef = z.infer<typeof seatRefSchema>;

export const holdSchema = z.object({
  id: z.uuid(),
  eventId: z.number().int(),
  status: holdStatusSchema,
  seats: z.array(seatRefSchema),
  /** ISO 8601, UTC. After this moment the seats are free again. */
  expiresAt: z.string(),
  event: eventSchema.pick({ id: true, title: true, city: true, startsAt: true }),
});
export type HoldDto = z.infer<typeof holdSchema>;

// ---------- orders ----------

export const orderSchema = z.object({
  id: z.uuid(),
  eventId: z.number().int(),
  event: eventSchema.pick({ id: true, title: true, city: true, startsAt: true }),
  seats: z.array(seatRefSchema),
  createdAt: z.string(),
});
export type OrderDto = z.infer<typeof orderSchema>;

export const orderListSchema = z.object({ items: z.array(orderSchema) });
export type OrderList = z.infer<typeof orderListSchema>;

// ---------- realtime (Socket.IO) ----------

/** Client -> server: "I am looking at the seat map of this event." The answer (acknowledgement) is the full current map. */
export const watchRequestSchema = z.object({ eventId: z.number().int().min(1).max(2_147_483_647) });
export type WatchRequest = z.infer<typeof watchRequestSchema>;

/** Server -> clients watching the event: these seats changed. Statuses only; who holds a seat is never sent. */
export const seatsChangedSchema = z.object({
  eventId: z.number().int(),
  changes: z.array(z.object({ seatId: z.number().int(), status: seatStatusSchema })),
});
export type SeatsChanged = z.infer<typeof seatsChangedSchema>;

export const SOCKET_EVENTS = { watch: "watch", unwatch: "unwatch", seatsChanged: "seats:changed" } as const;
export const seatRoom = (eventId: number): string => `event:${eventId}`;
