import { parseEventId } from "@app/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminEditLink } from "@/features/admin";
import { EventFacts } from "@/features/events";
import { getEvent } from "@/features/events/server";
import { SeatPicker } from "@/features/seats";

export const revalidate = 5;
export const dynamicParams = true;
export const metadata: Metadata = { title: "Choose seats" };

// Only the shell is shared: the seat map itself is loaded in the browser, fresh, with the visitor's own seats marked.
export function generateStaticParams() {
  return [];
}

export default async function SeatsPage({ params }: { params: Promise<{ id: string }> }) {
  const id = parseEventId((await params).id);
  if (id === null) notFound();
  const loaded = await getEvent(id);
  if (loaded.kind === "not-found") notFound();
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{loaded.kind === "ok" ? loaded.data.title : "Choose seats"}</h1>
        {loaded.kind === "ok" && <EventFacts event={loaded.data} />}
        <AdminEditLink eventId={id} />
      </div>
      <SeatPicker eventId={id} />
    </div>
  );
}
