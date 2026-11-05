"use client";

import type { OrderList } from "@app/shared";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/shared/lib/client-api";
import { queryKeys } from "@/shared/lib/query-keys";

/** The logged-in user's orders. The counter in the header is the length of this list, so both always agree. */
export function useOrders(enabled = true) {
  return useQuery({
    queryKey: queryKeys.orders,
    queryFn: ({ signal }) => apiRequest<OrderList>("/me/orders", { signal }),
    enabled,
  });
}
