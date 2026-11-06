"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/** False while the browser is hydrating the server's HTML (and on the server), true in every render after that. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

/**
 * A query that several components read (the logged-in user, the orders) is filled by whichever component asks first.
 * A browser that hydrates slowly can have the answer in the cache before the LAST of those components is hydrated; that
 * component would then draw real data where the server drew the "loading" placeholder, and React reports a mismatch
 * (error #418, seen in WebKit). So while hydrating, every reader sees "still loading", exactly like the server did; the
 * real result appears in the very next render.
 */
export function useHydrationSafe<T extends UseQueryResult<unknown, unknown>>(query: T): T {
  const hydrated = useHydrated();
  if (hydrated) return query;
  // One cast, on purpose: this is the shape of a query that has not answered yet.
  return { ...query, status: "pending", data: undefined, error: null, isPending: true, isSuccess: false, isError: false, isLoading: false, isFetching: false } as unknown as T;
}
