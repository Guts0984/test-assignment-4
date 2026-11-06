// Dates are formatted with a FIXED locale and time zone (UTC), never with the visitor's own settings. The server and the
// browser then produce exactly the same text, so there is nothing to disagree about during hydration.
const dateTime = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const dateOnly = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "long", day: "numeric", year: "numeric" });

/** "Nov 20, 2026, 6:00 PM UTC" */
export function formatDateTime(iso: string): string {
  // Newer ICU versions put a narrow no-break space before AM/PM; an ordinary space is the same on every machine.
  return `${dateTime.format(new Date(iso)).replace(/\u202f/g, " ")} UTC`;
}

/** "Fri, November 20, 2026" */
export function formatDay(iso: string): string {
  return dateOnly.format(new Date(iso));
}

/** Seconds left as "mm:ss"; never negative. */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}
