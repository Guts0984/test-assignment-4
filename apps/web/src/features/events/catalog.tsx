"use client";

import { eventListSchema, type EventList } from "@app/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { describeError } from "@/shared/lib/api-error";
import { apiRequest } from "@/shared/lib/client-api";
import { queryKeys, type EventFilters } from "@/shared/lib/query-keys";
import { useDebouncedValue } from "@/shared/lib/use-debounced-value";
import { Alert } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import { Skeleton } from "@/shared/ui/skeleton";
import { TextField } from "@/shared/ui/text-field";
import { EventFacts } from "./event-summary";
import { filtersToQuery, readFilters } from "./filters";

export const CITIES = ["Moscow", "Saint Petersburg", "Kazan", "Novosibirsk", "Yekaterinburg", "Sochi"] as const;

/**
 * The catalog. The filters live in the address (so a link or a reload keeps them); typing in the search box changes the
 * address only after a pause. Every distinct set of filters is its own cached query, so a slow answer for an OLD search can
 * never replace the answer for the current one. "Show more" loads the next page with a cursor (useInfiniteQuery).
 */
export function Catalog({ initialPage }: { initialPage: EventList | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);

  const [text, setText] = useState(filters.q ?? "");
  const debouncedText = useDebouncedValue(text.trim(), 300);

  // search box -> address (after the pause)
  useEffect(() => {
    if ((filters.q ?? "") === debouncedText) return;
    router.replace(`${pathname}${filtersToQuery({ ...filters, q: debouncedText || undefined })}`, { scroll: false });
  }, [debouncedText, filters, pathname, router]);

  const setFilter = (change: Partial<EventFilters>) => router.replace(`${pathname}${filtersToQuery({ ...filters, ...change })}`, { scroll: false });

  const isUnfiltered = Object.keys(filters).length === 0;
  const query = useInfiniteQuery({
    queryKey: queryKeys.events(filters),
    queryFn: async ({ pageParam, signal }) => eventListSchema.parse(await apiRequest(`/events${filtersToQuery(filters, pageParam)}`, { signal })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...(isUnfiltered && initialPage ? { initialData: { pages: [initialPage], pageParams: [undefined] } } : {}),
  });
  const events = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-6">
      <form role="search" aria-label="Find events" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => e.preventDefault()}>
        <TextField id="q" label="Search by title" type="search" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        <div className="space-y-1.5">
          <label htmlFor="city" className="text-sm font-medium leading-none">
            City
          </label>
          <select id="city" value={filters.city ?? ""} onChange={(e) => setFilter({ city: e.target.value || undefined })} className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm">
            <option value="">All cities</option>
            {CITIES.map((city) => (
              <option key={city} value={city}>
                {city}
              </option>
            ))}
          </select>
        </div>
        <TextField id="from" label="From" type="date" value={filters.from ?? ""} onChange={(e) => setFilter({ from: e.target.value || undefined })} />
        <TextField id="to" label="To" type="date" value={filters.to ?? ""} onChange={(e) => setFilter({ to: e.target.value || undefined })} />
      </form>

      <section aria-live="polite" aria-busy={query.isFetching} className="space-y-3">
        {query.isPending && <ListSkeleton />}
        {query.isError && (
          <Alert variant="destructive" className="flex items-center justify-between gap-3">
            <span>{describeError(query.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </Alert>
        )}
        {query.isSuccess && events.length === 0 && <p className="py-10 text-center text-muted-foreground">No upcoming events match these filters.</p>}
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="event-list">
          {events.map((event) => (
            <li key={event.id}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="space-y-2 pt-4">
                  <h2 className="text-lg font-medium leading-snug">
                    <Link href={`/events/${event.id}`} className="after:absolute after:inset-0 hover:underline">
                      {event.title}
                    </Link>
                  </h2>
                  <EventFacts event={event} />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
        {query.hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? "Loading…" : "Show more"}
            </Button>
          </div>
        )}
        {query.isFetchNextPageError && <Alert variant="destructive">{describeError(query.error)}</Alert>}
      </section>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-label="Loading events">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
    </div>
  );
}
