"use server";

import { eventSchema, issuesToFieldErrors, patchEventBodySchema, versionConflictDetailsSchema, type EventDto } from "@app/shared";
import { revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { sendPrivate } from "@/shared/lib/server-api";

export type Submitted = { title: string; description: string; version: number };

export type EditState =
  | { status: "idle" }
  | { status: "ok"; event: EventDto }
  /** Somebody saved first: `current` is what is saved now, `submitted` is what the editor typed (kept in the form). */
  | { status: "conflict"; current: EventDto; submitted: Submitted }
  | { status: "invalid"; fields: Record<string, string[]>; submitted: Submitted }
  | { status: "error"; message: string; submitted: Submitted };

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** Saves the form through the api. Runs on the server, so the cookie and the secret never reach the browser. */
export async function updateEvent(_previous: EditState, form: FormData): Promise<EditState> {
  const id = Number(text(form, "id"));
  const submitted: Submitted = { title: text(form, "title"), description: text(form, "description"), version: Number(text(form, "version")) };
  const parsed = patchEventBodySchema.safeParse(submitted);
  if (!parsed.success) return { status: "invalid", fields: issuesToFieldErrors(parsed.error.issues), submitted };

  const reply = await sendPrivate(`/events/${id}`, "PATCH", parsed.data);
  if (reply.status === 200) {
    const event = eventSchema.parse(reply.body);
    // The card and the list are rebuilt on their next visit - not served stale from the 5 second cache.
    revalidateTag(`event:${id}`, { expire: 0 });
    revalidateTag("events", { expire: 0 });
    return { status: "ok", event };
  }
  if (reply.status === 409) {
    const details = versionConflictDetailsSchema.safeParse((reply.body as { details?: unknown } | null)?.details);
    if (details.success) return { status: "conflict", current: details.data.current, submitted };
  }
  if (reply.status === 401) redirect(`/login?next=${encodeURIComponent(`/admin/events/${id}`)}`);
  if (reply.status === 403) return { status: "error", message: "Only an administrator can edit events.", submitted };
  if (reply.status === 404) return { status: "error", message: "This event does not exist.", submitted };
  const message = (reply.body as { message?: unknown } | null)?.message;
  return { status: "error", message: typeof message === "string" ? message : "Could not save. Try again.", submitted };
}
