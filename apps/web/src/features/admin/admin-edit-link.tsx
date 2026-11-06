"use client";

import Link from "next/link";
import { useMe } from "@/features/auth";
import { Button } from "@/shared/ui/button";

/**
 * "Edit event" for the administrator, nothing for anybody else. It is decided in the browser (the same logged-in check as the
 * header): the event pages come from a cache shared by everybody, so the button can never be part of their HTML.
 */
export function AdminEditLink({ eventId }: { eventId: number }) {
  const me = useMe();
  if (me.data?.role !== "admin") return null;
  return (
    <Button asChild variant="outline" size="lg">
      <Link href={`/admin/events/${eventId}`} data-testid="edit-event">
        Edit event
      </Link>
    </Button>
  );
}
