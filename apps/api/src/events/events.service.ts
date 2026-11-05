import {
  DEFAULT_PAGE_SIZE,
  ErrorCode,
  type EventDto,
  type EventList,
  type EventListQuery,
  type PatchEventBody,
} from "@app/shared";
import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AppError, notFound, validationError } from "../http/errors";
import { Infra } from "../infra/infra";
import { TwoLevelCache, type CachePolicy } from "./two-level-cache";

/** One event: kept in memory 5 s and in Redis 60 s; "no such event" is remembered for 3 s / 5 s. */
const EVENT_POLICY: CachePolicy = { memoryMs: 5000, redisSeconds: 60, missingMemoryMs: 3000, missingRedisSeconds: 5 };
/** A page of the list: shorter, because "which events are still upcoming" changes with time, not only with edits. */
const LIST_POLICY: CachePolicy = { memoryMs: 2000, redisSeconds: 15, missingMemoryMs: 2000, missingRedisSeconds: 15 };

type EventRow = {
  id: number;
  title: string;
  description: string;
  city: string;
  startsAt: Date;
  version: number;
  hall: { id: number; name: string };
};

const toDto = (row: EventRow): EventDto => ({
  id: row.id,
  title: row.title,
  description: row.description,
  city: row.city,
  startsAt: row.startsAt.toISOString(),
  hall: { id: row.hall.id, name: row.hall.name },
  version: row.version,
});

const HALL_SELECT = { select: { id: true, name: true } } as const;

export function encodeCursor(startsAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ t: startsAt, i: id })).toString("base64url");
}

/** The cursor comes from the client, so it is untrusted: anything odd is a 400, never a crash. */
export function decodeCursor(cursor: string): { startsAt: Date; id: number } {
  const bad = () => validationError({ cursor: ["The cursor is not valid."] });
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) throw bad();
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.i !== "number" || !Number.isInteger(parsed.i) || parsed.i < 1 || parsed.i > 2_147_483_647) throw bad();
    const startsAt = new Date(parsed.t);
    if (Number.isNaN(startsAt.getTime())) throw bad();
    return { startsAt, id: parsed.i };
  } catch {
    throw bad();
  }
}

/** In a LIKE pattern % and _ are wildcards and \\ is the escape character. A visitor's search text is plain text, so each of them gets escaped. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** "2026-11-20" as an upper bound means the end of that day. */
function boundary(value: string | undefined, endOfDay: boolean): Date | undefined {
  if (!value) return undefined;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) throw validationError({ [endOfDay ? "to" : "from"]: ["Not a valid date."] });
  return date;
}

@Injectable()
export class EventsService {
  private readonly cache: TwoLevelCache;

  constructor(@Inject(Infra) private readonly infra: Infra) {
    this.cache = new TwoLevelCache(infra.redis, infra.logger);
  }

  /** One event, or null. Both answers are cached. */
  getEvent(id: number): Promise<EventDto | null> {
    return this.cache.get("ev", String(id), EVENT_POLICY, async () => {
      const row = await this.infra.db.event.findUnique({ where: { id }, include: { hall: HALL_SELECT } });
      return row ? toDto(row) : null;
    });
  }

  /** Upcoming events, soonest first, with filters and a cursor. */
  async listEvents(query: EventListQuery): Promise<EventList> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const from = boundary(query.from, false);
    const to = boundary(query.to, true);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

    const key = createHash("sha1")
      .update(JSON.stringify([query.city?.toLowerCase() ?? null, query.q?.toLowerCase() ?? null, from?.toISOString() ?? null, to?.toISOString() ?? null, query.cursor ?? null, limit]))
      .digest("hex");
    const page = await this.cache.get<EventList>("evl", key, LIST_POLICY, () => this.loadPage({ city: query.city, q: query.q, from, to, cursor, limit }));
    const now = Date.now();
    // A cached page can be a few seconds old: an event that has started since is not "upcoming" any more.
    return { items: (page?.items ?? []).filter((event) => Date.parse(event.startsAt) > now), nextCursor: page?.nextCursor ?? null };
  }

  private async loadPage(options: { city: string | undefined; q: string | undefined; from: Date | undefined; to: Date | undefined; cursor: { startsAt: Date; id: number } | undefined; limit: number }): Promise<EventList> {
    const now = new Date();
    const rows = await this.infra.db.event.findMany({
      where: {
        startsAt: { gt: now, ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lte: options.to } : {}) },
        ...(options.city ? { city: { equals: options.city, mode: "insensitive" as const } } : {}),
        ...(options.q ? { title: { contains: escapeLike(options.q), mode: "insensitive" as const } } : {}),
        ...(options.cursor
          ? { OR: [{ startsAt: { gt: options.cursor.startsAt } }, { startsAt: options.cursor.startsAt, id: { gt: options.cursor.id } }] }
          : {}),
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: options.limit + 1,
      include: { hall: HALL_SELECT },
    });
    const pageRows = rows.slice(0, options.limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toDto),
      nextCursor: rows.length > options.limit && last ? encodeCursor(last.startsAt.toISOString(), last.id) : null,
    };
  }

  /**
   * Changes the title and/or description if the caller saw the current version. The check and the change are ONE
   * statement ("... WHERE id = $1 AND version = $2"), so of 20 editors who all saw version 1 exactly one wins; the
   * database raises the version. The losers get 409 with the event as it is saved now.
   */
  async patchEvent(id: number, body: PatchEventBody): Promise<EventDto> {
    const changed = await this.infra.db.event.updateMany({
      where: { id, version: body.version },
      data: { ...(body.title !== undefined ? { title: body.title } : {}), ...(body.description !== undefined ? { description: body.description } : {}) },
    });
    const row = await this.infra.db.event.findUnique({ where: { id }, include: { hall: HALL_SELECT } });
    if (!row) throw notFound("Event not found");
    if (changed.count === 0) {
      throw new AppError(409, ErrorCode.VERSION_CONFLICT, "The event was changed by someone else. Review the saved version.", { current: toDto(row) });
    }
    // Before answering: every cached copy, on every instance, becomes invalid (the next read loads the new data).
    await this.cache.invalidateAll();
    return toDto(row);
  }
}
