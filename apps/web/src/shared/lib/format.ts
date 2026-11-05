// Dates are formatted with a FIXED locale and time zone (UTC), never with the visitor's own settings. The server and the
// browser then produce exactly the same text, so there is nothing to disagree about during hydration.
const dateTime = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const dateOnly = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "long", year: "numeric" });

/** "20 Nov 2026, 18:00 UTC" */
export function formatDateTime(iso: string): string {
  return `${dateTime.format(new Date(iso))} UTC`;
}

/** "Fri, 20 November 2026" */
export function formatDay(iso: string): string {
  return dateOnly.format(new Date(iso));
}

/** Seconds left as "mm:ss"; never negative. */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}
