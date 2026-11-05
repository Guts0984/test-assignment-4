"use client";

import { Alert } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";

/** Any page that fails while it is drawn ends up here instead of showing a blank screen. */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md space-y-4 py-16">
      <Alert variant="destructive">Something went wrong while showing this page.</Alert>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
