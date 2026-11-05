import type { EventDto } from "@app/shared";
import Link from "next/link";
import { Button } from "@/shared/ui/button";
import { EventFacts } from "./event-summary";

/** Title, facts, description and the way to the seats. */
export function EventHeading({ event }: { event: EventDto }) {
  return (
    <article className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight" data-testid="event-title">
        {event.title}
      </h1>
      <EventFacts event={event} />
      <p className="max-w-prose whitespace-pre-line text-base leading-relaxed" data-testid="event-description">
        {event.description}
      </p>
      <Button asChild size="lg">
        <Link href={`/events/${event.id}/seats`}>Choose seats</Link>
      </Button>
    </article>
  );
}
