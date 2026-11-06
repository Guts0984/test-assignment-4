"use client";

import { MAX_SEATS_PER_USER, seatMapSchema, type HoldDto, type SeatMap } from "@app/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef, type KeyboardEvent } from "react";
import { useMe } from "@/features/auth";
import { describeError, isApiError } from "@/shared/lib/api-error";
import { apiRequest } from "@/shared/lib/client-api";
import { queryKeys } from "@/shared/lib/query-keys";
import { cn } from "@/shared/lib/utils";
import { Alert } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { applyChanges, emptySelection, lostSeats, mergeSnapshot, seatLabel, selectionReducer, statusText } from "./seat-state";
import { useSeatSocket } from "./use-seat-socket";

const newKey = (): string => `hold-${crypto.randomUUID()}`;

/** The hall: choose seats with the mouse or the keyboard, watch other people's choices appear live, hold what you chose. */
export function SeatPicker({ eventId }: { eventId: number }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  const [selection, dispatch] = useReducer(selectionReducer, emptySelection);
  const gridRef = useRef<HTMLDivElement>(null);

  const seatsKey = queryKeys.seats(eventId);
  const seats = useQuery({ queryKey: seatsKey, queryFn: async ({ signal }) => seatMapSchema.parse(await apiRequest(`/events/${eventId}/seats`, { signal })), staleTime: 0 });

  // Live updates. A snapshot replaces the map (with the changes that raced it applied on top); a change edits it in place.
  const live = useSeatSocket(eventId, {
    onSnapshot: (map, meanwhile) => queryClient.setQueryData(seatsKey, mergeSnapshot(map, meanwhile)),
    onChanges: (changes) => queryClient.setQueryData<SeatMap>(seatsKey, (current) => (current ? applyChanges(current, changes) : current)),
  });
  // Without the live connection, fall back to asking every few seconds.
  useEffect(() => {
    if (live === "live") return;
    const timer = setInterval(() => void queryClient.invalidateQueries({ queryKey: seatsKey }), 5000);
    return () => clearInterval(timer);
  }, [live, queryClient, seatsKey]);

  // A seat I chose that somebody else got first: unmark it and say so (the rollback).
  useEffect(() => {
    if (!seats.data) return;
    const lost = lostSeats(seats.data, selection.selected);
    if (lost.length > 0) dispatch({ type: "rollback", seatIds: lost, message: `${lost.length === 1 ? "A seat you chose was" : "Some seats you chose were"} just taken by someone else.` });
  }, [seats.data, selection.selected]);

  // One idempotency key per attempt: pressing the button twice, or a retry after a network error, is the SAME request.
  const attempt = useRef({ key: newKey(), signature: "" });
  const hold = useMutation({
    mutationFn: (seatIds: number[]) => {
      const signature = [...seatIds].sort((a, b) => a - b).join(",");
      if (attempt.current.signature !== signature) attempt.current = { key: newKey(), signature };
      return apiRequest<{ hold: HoldDto }>(`/events/${eventId}/holds`, { body: { seatIds }, headers: { "Idempotency-Key": attempt.current.key } });
    },
    onSuccess: ({ hold: created }) => {
      attempt.current = { key: newKey(), signature: "" };
      dispatch({ type: "clear" });
      void queryClient.invalidateQueries({ queryKey: seatsKey });
      router.push(`/checkout/${created.id}`);
    },
    onError: (error, seatIds) => {
      if (!isApiError(error)) return dispatch({ type: "notice", message: "Could not reach the server. Press the button again - nothing is held twice." });
      attempt.current = { key: newKey(), signature: "" }; // a final answer: the next attempt is a new request
      void queryClient.invalidateQueries({ queryKey: seatsKey });
      if (error.status === 401) return router.push(`/login?next=${encodeURIComponent(`/events/${eventId}/seats`)}`);
      if (error.code === "SOLD_OUT") {
        const taken = (error.details as { seatIds?: number[] } | undefined)?.seatIds ?? seatIds;
        return dispatch({ type: "rollback", seatIds: taken, message: "Someone else just took " + (taken.length === 1 ? "one of the seats" : "some of the seats") + ". They are unmarked - please choose again." });
      }
      dispatch({ type: "notice", message: error.message });
    },
  });

  const toggle = useCallback(
    (seatId: number, status: "free" | "held" | "sold", mine: boolean) => {
      if (!hold.isPending) dispatch({ type: "toggle", seatId, status, mine });
    },
    [hold.isPending],
  );

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const row = Number(target.dataset["row"]);
    const col = Number(target.dataset["col"]);
    if (Number.isNaN(row) || Number.isNaN(col)) return;
    const move = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0], Home: [0, -col], End: [0, 1000] }[event.key];
    if (!move) return;
    event.preventDefault();
    const [dr, dc] = move as [number, number];
    const rows = gridRef.current?.querySelectorAll<HTMLElement>("[data-row-group]") ?? [];
    const nextRow = rows[Math.min(Math.max(row + dr, 0), rows.length - 1)];
    const cells = nextRow?.querySelectorAll<HTMLElement>("button") ?? [];
    cells[Math.min(Math.max(col + dc, 0), cells.length - 1)]?.focus();
  };

  if (seats.isPending) return <Skeleton className="h-72 w-full" aria-label="Loading the hall" />;
  if (seats.isError) {
    return (
      <Alert variant="destructive" className="flex items-center justify-between gap-3">
        <span>{describeError(seats.error)}</span>
        <Button size="sm" variant="outline" onClick={() => void seats.refetch()}>
          Try again
        </Button>
      </Alert>
    );
  }

  const map = seats.data;
  const chosen = new Set(selection.selected);
  const names = map.rows.flatMap((row) => row.seats.filter((seat) => chosen.has(seat.id)).map((seat) => seatLabel(row.label, seat.number)));
  const firstFocusable = map.rows.flatMap((row) => row.seats).find((seat) => seat.status === "free")?.id;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {live === "live" ? "Live: other people's choices appear here at once." : live === "connecting" ? "Connecting to live updates…" : "Live updates are off; refreshing every few seconds."}
      </p>

      {map.myHoldIds.length > 0 && (
        <Alert>
          You have seats on hold.{" "}
          <Link className="font-medium underline" href={`/checkout/${map.myHoldIds[0]}`}>
            Continue to payment
          </Link>
        </Alert>
      )}

      <div className="mx-auto w-full max-w-3xl overflow-x-auto rounded-xl border bg-card p-4">
        <div className="mb-4 rounded-md bg-muted py-1 text-center text-xs font-medium uppercase tracking-widest text-muted-foreground">Stage</div>
        <div ref={gridRef} role="group" aria-label="Seats" onKeyDown={onGridKeyDown} className="space-y-1.5" data-testid="seat-grid">
          {map.rows.map((row, rowIndex) => (
            <div key={row.label} data-row-group className="flex items-center gap-1.5">
              <span className="w-5 shrink-0 text-center text-xs text-muted-foreground" aria-hidden>
                {row.label}
              </span>
              <div className="flex flex-1 justify-center gap-1">
                {row.seats.map((seat, colIndex) => {
                  const isChosen = chosen.has(seat.id);
                  const taken = seat.status !== "free" && !seat.mine;
                  return (
                    <button
                      key={seat.id}
                      type="button"
                      data-row={rowIndex}
                      data-col={colIndex}
                      data-seat={seatLabel(row.label, seat.number)}
                      data-status={isChosen ? "chosen" : seat.mine ? "mine" : seat.status}
                      aria-label={`Row ${row.label}, seat ${seat.number}, ${isChosen ? "chosen by you" : statusText(seat.status, seat.mine)}`}
                      aria-pressed={isChosen}
                      aria-disabled={taken || seat.mine}
                      tabIndex={seat.id === firstFocusable ? 0 : -1}
                      onClick={() => toggle(seat.id, seat.status, seat.mine)}
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-md border text-[10px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:size-7",
                        isChosen && "border-primary bg-primary text-primary-foreground",
                        !isChosen && seat.status === "free" && "bg-background hover:bg-accent",
                        !isChosen && seat.mine && "border-emerald-600 bg-emerald-100 text-emerald-900",
                        taken && seat.status === "held" && "cursor-not-allowed border-dashed bg-amber-100 text-amber-900",
                        taken && seat.status === "sold" && "cursor-not-allowed bg-muted text-muted-foreground line-through",
                      )}
                    >
                      {/* Your own held or bought seat shows a tick, as the legend says (the label above still names the seat). */}
                      {!isChosen && seat.mine ? <span aria-hidden="true">✓</span> : seat.number}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
          <li>□ free</li>
          <li>■ chosen by you</li>
          <li>▨ held by someone</li>
          <li>▬ sold</li>
          <li>✓ yours</li>
        </ul>
      </div>

      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3">
        <div aria-live="polite" className="text-sm" data-testid="selection-summary">
          {names.length === 0 ? `Choose up to ${MAX_SEATS_PER_USER} seats.` : `Chosen (${names.length}): ${names.join(", ")}`}
        </div>
        <div className="flex gap-2">
          {names.length > 0 && (
            <Button variant="ghost" onClick={() => dispatch({ type: "clear" })} disabled={hold.isPending}>
              Clear
            </Button>
          )}
          <Button
            data-testid="hold-button"
            disabled={names.length === 0 || hold.isPending || me.isPending}
            onClick={() => (me.data ? hold.mutate(selection.selected) : router.push(`/login?next=${encodeURIComponent(`/events/${eventId}/seats`)}`))}
          >
            {hold.isPending ? "Holding…" : me.data || me.isPending ? `Hold ${names.length || ""} seat${names.length === 1 ? "" : "s"}` : "Log in to hold seats"}
          </Button>
        </div>
      </div>
      {selection.notice && (
        <Alert variant="destructive" data-testid="seat-notice">
          {selection.notice}
        </Alert>
      )}
    </div>
  );
}
