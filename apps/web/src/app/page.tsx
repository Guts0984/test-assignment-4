import { Suspense } from "react";
import { Catalog } from "@/features/events";
import { getFirstPage } from "@/features/events/server";
import { Skeleton } from "@/shared/ui/skeleton";

// The same page for every visitor: Next.js rebuilds it at most every 5 seconds (and at once when an event is edited).
export const revalidate = 5;

export default async function HomePage() {
  const first = await getFirstPage();
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Upcoming events</h1>
      {/* The catalog reads the filters from the address, which needs a Suspense boundary. */}
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <Catalog initialPage={first.kind === "ok" ? first.data : null} />
      </Suspense>
    </div>
  );
}
