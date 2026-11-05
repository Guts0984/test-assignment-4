// Every piece of server data the browser keeps has one key here, so it is clear what to refresh after a change.
export type EventFilters = { city?: string; q?: string; from?: string; to?: string };

export const queryKeys = {
  /** The logged-in user (null when nobody is logged in). */
  me: ["me"] as const,
  /** The user's orders. The counter in the header is the length of this list. */
  orders: ["orders"] as const,
  events: (filters: EventFilters) => ["events", filters] as const,
  seats: (eventId: number) => ["seats", eventId] as const,
  hold: (holdId: string) => ["hold", holdId] as const,
  event: (eventId: number) => ["event", eventId] as const,
};
