import { parseEventId } from "@app/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EventDetailClient, EventHeading } from "@/features/events";
import { getEvent, nearestEventIds } from "@/features/events/server";

// Built ahead for the 20 nearest events; any other event is built on its first visit and then kept. Either way the page is
// rebuilt at most every 5 seconds, and at once when the event is edited (tag "event:<id>").
export const revalidate = 5;
export const dynamicParams = true;

export async function generateStaticParams() {
  return (await nearestEventIds()).map((id) => ({ id: String(id) }));
}

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const id = parseEventId((await params).id);
  if (id === null) return { title: "Not found" };
  const loaded = await getEvent(id);
  return { title: loaded.kind === "ok" ? loaded.data.title : "Event" };
}

export default async function EventPage({ params }: Props) {
  // "abc", "0", "1.5" ... are simply events that do not exist: a real 404.
  const id = parseEventId((await params).id);
  if (id === null) notFound();
  const loaded = await getEvent(id);
  if (loaded.kind === "not-found") notFound();
  return loaded.kind === "ok" ? <EventHeading event={loaded.data} /> : <EventDetailClient id={id} />;
}
