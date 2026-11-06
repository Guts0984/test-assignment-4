"use client";

import type { PublicUser } from "@app/shared";
import { useQuery } from "@tanstack/react-query";
import { isApiError } from "@/shared/lib/api-error";
import { apiRequest } from "@/shared/lib/client-api";
import { useHydrationSafe } from "@/shared/lib/hydration-safe-query";
import { queryKeys } from "@/shared/lib/query-keys";

/** The logged-in user, or null for a visitor. Fetched in the browser (never in a shared server cache: it is personal). */
export function useMe() {
  const query = useQuery({
    queryKey: queryKeys.me,
    queryFn: async ({ signal }): Promise<PublicUser | null> => {
      try {
        return (await apiRequest<{ user: PublicUser }>("/me", { signal })).user;
      } catch (error) {
        if (isApiError(error) && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 30_000,
  });
  return useHydrationSafe(query);
}
