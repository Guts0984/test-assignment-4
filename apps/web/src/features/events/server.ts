import "server-only";
import { eventListSchema, eventSchema, type EventDto, type EventList } from "@app/shared";
import { loadPublic, type Loaded } from "@/shared/lib/server-api";

/** One event, kept by Next.js for 5 seconds and dropped at once when its tag is revalidated. Anyone may see it. */
export async function getEvent(id: number): Promise<Loaded<EventDto>> {
  const loaded = await loadPublic<unknown>(`/events/${id}`, ["events", `event:${id}`]);
  return loaded.kind === "ok" ? { kind: "ok", data: eventSchema.parse(loaded.data) } : loaded;
}

/** The first page of the unfiltered list (what the catalog shows before any filter is chosen). */
export async function getFirstPage(): Promise<Loaded<EventList>> {
  const loaded = await loadPublic<unknown>("/events?limit=20", ["events"]);
  return loaded.kind === "ok" ? { kind: "ok", data: eventListSchema.parse(loaded.data) } : loaded;
}

/**
 * The ids of the events whose pages are built ahead, when the site is built: the 20 nearest ones.
 * When the api cannot be reached while building (a Docker build has no api next to it), the events the seed creates
 * first are the nearest ones, so ids 1 to 20 are used. Any other event is built when it is first asked for, then kept.
 */
export async function nearestEventIds(): Promise<number[]> {
  const loaded = await getFirstPage();
  if (loaded.kind === "ok") return loaded.data.items.map((event) => event.id);
  return Array.from({ length: 20 }, (_, index) => index + 1);
}
