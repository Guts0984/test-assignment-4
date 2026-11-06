"use client";

import type { OrderList } from "@app/shared";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/shared/lib/client-api";
import { useHydrationSafe } from "@/shared/lib/hydration-safe-query";
import { queryKeys } from "@/shared/lib/query-keys";

/** The logged-in user's orders. The counter in the header is the length of this list, so both always agree. */
export function useOrders(enabled = true) {
  const query = useQuery({
    queryKey: queryKeys.orders,
    queryFn: ({ signal }) => apiRequest<OrderList>("/me/orders", { signal }),
    enabled,
  });
  return useHydrationSafe(query);
}
