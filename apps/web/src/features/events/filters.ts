import type { EventFilters } from "@/shared/lib/query-keys";

type Params = { get(name: string): string | null };

/** Filters as written in the address: ?city=Kazan&q=jazz&from=2026-12-01 . Empty values do not count. */
export function readFilters(params: Params): EventFilters {
  const filters: EventFilters = {};
  for (const name of ["city", "q", "from", "to"] as const) {
    const value = params.get(name)?.trim();
    if (value) filters[name] = value;
  }
  return filters;
}

/** "?city=Kazan&q=jazz" (or "" when there is nothing), optionally with a cursor for the next page. */
export function filtersToQuery(filters: EventFilters, cursor?: string): string {
  const search = new URLSearchParams();
  for (const name of ["city", "q", "from", "to"] as const) {
    const value = filters[name];
    if (value) search.set(name, value);
  }
  if (cursor) search.set("cursor", cursor);
  const text = search.toString();
  return text ? `?${text}` : "";
}
