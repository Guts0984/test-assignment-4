import { z } from "zod";

// ---------- what the api returns ----------

export const eventSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  city: z.string(),
  /** ISO 8601, always UTC ("2026-11-20T18:00:00.000Z"). */
  startsAt: z.string(),
  hall: z.object({ id: z.number().int(), name: z.string() }),
  /** Raised by one on every change. Send it back when editing: if it moved meanwhile, the edit is refused (409). */
  version: z.number().int(),
});
export type EventDto = z.infer<typeof eventSchema>;

export const eventListSchema = z.object({
  items: z.array(eventSchema),
  /** Pass it back as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type EventList = z.infer<typeof eventListSchema>;

// ---------- what the api accepts ----------

/** An empty text box in a form arrives as "" - treat it as "not given". */
const optionalText = (max: number) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().trim().min(1).max(max).optional());

const dayOrMoment = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const optionalDate = z.preprocess((value) => (value === "" ? undefined : value), dayOrMoment.optional());

export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

export const eventListQuerySchema = z.strictObject({
  city: optionalText(100),
  /** Search in the title. */
  q: optionalText(100),
  /** Events that start on or after this day / moment. */
  from: optionalDate,
  /** Events that start on or before this day (a plain day means the whole day) / moment. */
  to: optionalDate,
  cursor: z.preprocess((value) => (value === "" ? undefined : value), z.string().max(200).optional()),
  limit: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : Number(value)),
    z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  ),
});
export type EventListQuery = z.infer<typeof eventListQuerySchema>;

export const titleSchema = z.string().trim().min(1, "Enter a title").max(200, "The title can have at most 200 characters");
export const descriptionSchema = z.string().max(5000, "The description can have at most 5000 characters");

export const patchEventBodySchema = z
  .strictObject({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    /** The version the editor saw. */
    version: z.number().int().min(1).max(2_147_483_647),
  })
  .refine((body) => body.title !== undefined || body.description !== undefined, {
    message: "Change at least the title or the description.",
    path: ["title"],
  });
export type PatchEventBody = z.infer<typeof patchEventBodySchema>;

/** `details` of a 409 VERSION_CONFLICT: the event as it is saved now. */
export const versionConflictDetailsSchema = z.object({ current: eventSchema });
export type VersionConflictDetails = z.infer<typeof versionConflictDetailsSchema>;

/**
 * An event id from a URL. Anything that is not a plain positive whole number that fits the database ("abc", "0", "-1",
 * "1.5", "1e3", "007", a 30-digit number, a NUL byte ...) is simply "no such event": the answer is 404, not 400.
 */
export function parseEventId(raw: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= 2_147_483_647 ? id : null;
}
