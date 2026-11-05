"use client";

import { eventSchema } from "@app/shared";
import { useQuery } from "@tanstack/react-query";
import { describeError } from "@/shared/lib/api-error";
import { apiRequest } from "@/shared/lib/client-api";
import { queryKeys } from "@/shared/lib/query-keys";
import { Alert } from "@/shared/ui/alert";
import { Skeleton } from "@/shared/ui/skeleton";
import { EventHeading } from "./event-heading";

/**
 * Used when the server could not read the event while building the page (the api is not reachable at build time):
 * the page shell is ready, and the browser fetches the facts. The server renders the real thing again a few seconds later.
 */
export function EventDetailClient({ id }: { id: number }) {
  const query = useQuery({ queryKey: queryKeys.event(id), queryFn: async ({ signal }) => eventSchema.parse(await apiRequest(`/events/${id}`, { signal })) });
  if (query.isPending) return <Skeleton className="h-40 w-full" aria-label="Loading the event" />;
  if (query.isError) return <Alert variant="destructive">{describeError(query.error)}</Alert>;
  return <EventHeading event={query.data} />;
}
