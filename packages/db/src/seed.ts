import type { Db } from "./client";
import { Role } from "./generated/client";
import { hashPassword } from "./password";

export const CITIES = ["Moscow", "Saint Petersburg", "Kazan", "Novosibirsk", "Yekaterinburg", "Sochi"] as const;

/** The two halls required by the assignment: 8 x 15 = 120 seats and 10 x 20 = 200 seats. */
export const HALLS = [
  { name: "Main Hall", rows: 8, seatsPerRow: 15 },
  { name: "Grand Hall", rows: 10, seatsPerRow: 20 },
] as const;

export const SEED_USERS = [
  { email: "admin@example.com", role: Role.ADMIN },
  { email: "alice@example.com", role: Role.USER },
  { email: "bob@example.com", role: Role.USER },
] as const;

export const EVENT_COUNT = 100;
/** Events start between tomorrow and SPREAD_DAYS + 1 days from today: inside "the next 2 months" (60 days). */
const SPREAD_DAYS = 58;

const KINDS = ["Concert", "Theatre", "Stand-up", "Opera", "Ballet", "Jazz Night", "Symphony", "Musical", "Festival", "Lecture"];
const NAMES = ["Aurora", "Meridian", "Horizon", "Nocturne", "Solstice", "Echo", "Cascade", "Zenith", "Lumen", "Harbor"];

export type SeedConfig = {
  adminPassword: string;
  userPassword: string;
};

export type SeedSummary = { halls: number; seats: number; users: number; events: number; eventSeats: number };

export type EventDraft = {
  title: string;
  description: string;
  city: string;
  startsAt: Date;
  hallIndex: number;
};

/** Row labels A, B, C, ... */
export function rowLabel(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

/**
 * The 100 events, computed only from `now` (same input, same output). Events are spread over the next
 * 59 days, one every ~14 hours on average, in the evening (17:00-20:00 UTC), cities and halls alternating.
 */
export function buildEvents(now: Date): EventDraft[] {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: EVENT_COUNT }, (_, i) => {
    const city = CITIES[i % CITIES.length] as string;
    const kind = KINDS[i % KINDS.length] as string;
    const name = NAMES[Math.floor(i / KINDS.length) % NAMES.length] as string;
    const day = 1 + Math.floor((i * SPREAD_DAYS) / (EVENT_COUNT - 1));
    const hour = 17 + (i % 4);
    return {
      title: `${kind}: ${name}`,
      description: `${kind} "${name}" in ${city}. Doors open one hour before the start.`,
      city,
      startsAt: new Date(midnight + day * 86_400_000 + hour * 3_600_000),
      // Not i % 2: with 6 cities that would tie every city to one hall.
      hallIndex: Math.floor(i / CITIES.length) % HALLS.length,
    };
  });
}

/**
 * Fills an empty database. Running it again changes nothing:
 * - halls, seats and users are looked up before they are created;
 * - the events are created only if there are none (they have no natural unique key);
 * - the seat rows of events use ON CONFLICT DO NOTHING;
 * - everything runs in one transaction under an advisory lock, so two seeders started at the same time
 *   (for example two containers) cannot both insert.
 */
export async function seed(db: Db, config: SeedConfig, now: Date = new Date()): Promise<SeedSummary> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('seed', 0))`;

      const halls = await Promise.all(
        HALLS.map((hall) =>
          tx.hall.upsert({ where: { name: hall.name }, update: {}, create: { name: hall.name } }),
        ),
      );
      for (const [index, hall] of HALLS.entries()) {
        const hallId = (halls[index] as { id: number }).id;
        await tx.seat.createMany({
          data: Array.from({ length: hall.rows * hall.seatsPerRow }, (_, n) => ({
            hallId,
            row: rowLabel(Math.floor(n / hall.seatsPerRow)),
            number: (n % hall.seatsPerRow) + 1,
          })),
          skipDuplicates: true,
        });
      }

      for (const user of SEED_USERS) {
        const exists = await tx.user.findUnique({ where: { email: user.email }, select: { id: true } });
        if (exists) continue;
        const password = user.role === Role.ADMIN ? config.adminPassword : config.userPassword;
        await tx.user.create({ data: { email: user.email, role: user.role, passwordHash: await hashPassword(password) } });
      }

      if ((await tx.event.count()) === 0) {
        await tx.event.createMany({
          data: buildEvents(now).map(({ hallIndex, ...event }) => ({
            ...event,
            hallId: (halls[hallIndex] as { id: number }).id,
          })),
        });
      }

      await tx.$executeRaw`
        INSERT INTO event_seats (event_id, seat_id)
        SELECT e.id, s.id FROM events e JOIN seats s ON s.hall_id = e.hall_id
        ON CONFLICT (event_id, seat_id) DO NOTHING`;

      const [hallCount, seatCount, userCount, eventCount, eventSeatCount] = await Promise.all([
        tx.hall.count(),
        tx.seat.count(),
        tx.user.count(),
        tx.event.count(),
        tx.eventSeat.count(),
      ]);
      return { halls: hallCount, seats: seatCount, users: userCount, events: eventCount, eventSeats: eventSeatCount };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
