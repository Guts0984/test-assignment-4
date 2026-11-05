"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { isApiError } from "./lib/api-error";

/** One query client per browser tab. Data is considered fresh for 5 seconds; a 4xx answer is final and is not retried. */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5000,
            refetchOnWindowFocus: true,
            retry: (count, error) => (isApiError(error) && error.status < 500 ? false : count < 2),
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
