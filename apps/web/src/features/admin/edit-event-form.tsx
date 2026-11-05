"use client";

import type { EventDto } from "@app/shared";
import { useActionState } from "react";
import { formatDateTime } from "@/shared/lib/format";
import { Alert } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { TextField } from "@/shared/ui/text-field";
import { updateEvent, type EditState } from "./actions";

/**
 * Admin form. If somebody else saved first (the version moved), the SAVED version is shown beside the form and what you
 * typed stays in the fields, so nothing is lost; the form now carries the saved version's number, so pressing Save again
 * is a deliberate overwrite.
 */
export function EditEventForm({ event }: { event: EventDto }) {
  const [state, action, pending] = useActionState<EditState, FormData>(updateEvent, { status: "idle" });

  const shown =
    state.status === "idle" ? { title: event.title, description: event.description, version: event.version } : state.status === "ok" ? { title: state.event.title, description: state.event.description, version: state.event.version } : state.submitted;
  const version = state.status === "conflict" ? state.current.version : shown.version;
  const fieldErrors = state.status === "invalid" ? state.fields : {};
  // A new key re-creates the inputs, which then start from the values above (a form is otherwise reset after an action).
  const formKey = `${state.status}-${version}-${state.status === "conflict" ? state.current.version : ""}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <form key={formKey} action={action} className="space-y-4" aria-labelledby="edit-title" noValidate>
        <h1 id="edit-title" className="text-2xl font-semibold">
          Edit event
        </h1>
        <input type="hidden" name="id" value={event.id} />
        <input type="hidden" name="version" value={version} />
        <p className="text-sm text-muted-foreground">
          {event.city} · {formatDateTime(event.startsAt)} · version {version}
        </p>

        {state.status === "ok" && <Alert data-testid="saved">Saved. The page and the list show the change within a few seconds.</Alert>}
        {state.status === "error" && <Alert variant="destructive">{state.message}</Alert>}
        {state.status === "conflict" && (
          <Alert variant="destructive" data-testid="conflict">
            Someone else saved this event while you were editing (it is now version {state.current.version}). What you typed is still in the form; the saved version is on the right. Press Save to overwrite it with yours.
          </Alert>
        )}

        <TextField id="title" name="title" label="Title" defaultValue={shown.title} errors={fieldErrors["title"]} maxLength={400} />
        <div className="space-y-1.5">
          <Label htmlFor="description">Description</Label>
          <Textarea id="description" name="description" rows={8} defaultValue={shown.description} aria-invalid={fieldErrors["description"] ? true : undefined} aria-describedby={fieldErrors["description"] ? "description-error" : undefined} />
          {fieldErrors["description"] && (
            <p id="description-error" role="alert" className="text-sm text-destructive">
              {fieldErrors["description"].join(" ")}
            </p>
          )}
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>

      {state.status === "conflict" && (
        <aside aria-label="Saved version" className="space-y-2 rounded-xl border bg-muted/40 p-4 text-sm" data-testid="saved-version">
          <h2 className="font-semibold">Saved version {state.current.version}</h2>
          <p className="font-medium">{state.current.title}</p>
          <p className="whitespace-pre-line text-muted-foreground">{state.current.description}</p>
        </aside>
      )}
    </div>
  );
}
