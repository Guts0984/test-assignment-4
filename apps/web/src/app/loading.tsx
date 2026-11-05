import { Skeleton } from "@/shared/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4" aria-label="Loading">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
