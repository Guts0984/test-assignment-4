import { eventSchema, parseEventId } from "@app/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { EditEventForm } from "@/features/admin";
import { Alert } from "@/shared/ui/alert";
import { loadPrivate } from "@/shared/lib/server-api";

export const metadata: Metadata = { title: "Edit event" };
// Personal and always current (it carries the version number to be edited): never served from a shared copy.
export const dynamic = "force-dynamic";

export default async function AdminEventPage({ params }: { params: Promise<{ id: string }> }) {
  const raw = (await params).id;
  const id = parseEventId(raw);
  if (id === null) notFound();
  const loaded = await loadPrivate<unknown>(`/events/${id}`);
  if (loaded.kind === "unauthenticated") redirect(`/login?next=${encodeURIComponent(`/admin/events/${id}`)}`);
  if (loaded.kind === "not-found") notFound();
  if (loaded.kind !== "ok") return <Alert variant="destructive">The event could not be loaded. Try again in a moment.</Alert>;
  return <EditEventForm event={eventSchema.parse(loaded.data)} />;
}
