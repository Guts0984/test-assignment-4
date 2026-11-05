import type { EventDto } from "@app/shared";
import { CalendarDays, MapPin } from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";
import { Badge } from "@/shared/ui/badge";

/** The facts about an event, shown on the card and in lists. No client code: pure markup. */
export function EventFacts({ event }: { event: Pick<EventDto, "city" | "startsAt"> & { hall?: EventDto["hall"] } }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <li className="flex items-center gap-1.5">
        <CalendarDays className="size-4" aria-hidden />
        <time dateTime={event.startsAt}>{formatDateTime(event.startsAt)}</time>
      </li>
      <li className="flex items-center gap-1.5">
        <MapPin className="size-4" aria-hidden />
        {event.city}
      </li>
      {event.hall && <li><Badge variant="outline">{event.hall.name}</Badge></li>}
    </ul>
  );
}
