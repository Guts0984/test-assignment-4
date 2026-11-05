import { MAX_SEATS_PER_USER, type SeatMap, type SeatsChanged, type SeatStatus } from "@app/shared";

/** What the visitor has chosen on this page but not yet held. This is the "optimistic" part: a click marks the seat at once. */
export type Selection = { selected: number[]; notice: string | null };

export const emptySelection: Selection = { selected: [], notice: null };

export type SelectionAction =
  | { type: "toggle"; seatId: number; status: SeatStatus; mine: boolean }
  /** Seats that were chosen but are gone (someone else got them first): take them out and say why. */
  | { type: "rollback"; seatIds: number[]; message: string }
  | { type: "clear" }
  | { type: "notice"; message: string }
  | { type: "dismiss" };

/** Pure: the same state and action always give the same result, so quick repeated clicks cannot get out of step. */
export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  switch (action.type) {
    case "toggle": {
      if (state.selected.includes(action.seatId)) return { selected: state.selected.filter((id) => id !== action.seatId), notice: null };
      if (action.status !== "free" || action.mine) return { ...state, notice: "That seat is not available." };
      if (state.selected.length >= MAX_SEATS_PER_USER) return { ...state, notice: `You can choose at most ${MAX_SEATS_PER_USER} seats.` };
      return { selected: [...state.selected, action.seatId], notice: null };
    }
    case "rollback": {
      const gone = new Set(action.seatIds);
      const remaining = state.selected.filter((id) => !gone.has(id));
      return remaining.length === state.selected.length ? state : { selected: remaining, notice: action.message };
    }
    case "clear":
      return emptySelection;
    case "notice":
      return { ...state, notice: action.message };
    case "dismiss":
      return state.notice === null ? state : { ...state, notice: null };
  }
}

/** Applies live changes (from Socket.IO) to a map. A seat that turns free is nobody's any more; one that changes hands is not "mine". */
export function applyChanges(map: SeatMap, changes: SeatsChanged["changes"]): SeatMap {
  if (changes.length === 0) return map;
  const latest = new Map(changes.map((change) => [change.seatId, change.status] as const));
  return {
    ...map,
    rows: map.rows.map((row) => ({
      ...row,
      seats: row.seats.map((seat) => {
        const status = latest.get(seat.id);
        if (status === undefined || status === seat.status) return seat;
        return { ...seat, status, mine: status === "free" ? false : seat.mine && seat.status !== "free" };
      }),
    })),
  };
}

/**
 * The full map from the server, plus the changes that arrived while it was on its way. The map was read at some moment
 * and the changes may be newer than that, so they are applied on top (never the other way round).
 */
export function mergeSnapshot(map: SeatMap, changesReceivedMeanwhile: SeatsChanged["changes"]): SeatMap {
  return applyChanges(map, changesReceivedMeanwhile);
}

/** Chosen seats that someone else has taken since. */
export function lostSeats(map: SeatMap, selected: readonly number[]): number[] {
  if (selected.length === 0) return [];
  const wanted = new Set(selected);
  return map.rows.flatMap((row) => row.seats).filter((seat) => wanted.has(seat.id) && seat.status !== "free" && !seat.mine).map((seat) => seat.id);
}

export function seatLabel(rowLabel: string, number: number): string {
  return `${rowLabel}${number}`;
}

export function statusText(status: SeatStatus, mine: boolean): string {
  if (mine) return status === "sold" ? "yours, bought" : "held for you";
  return status === "free" ? "free" : status === "held" ? "held by someone" : "sold";
}
