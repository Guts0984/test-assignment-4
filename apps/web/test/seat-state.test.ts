import { MAX_SEATS_PER_USER, type SeatMap } from "@app/shared";
import { describe, expect, it } from "vitest";
import { applyChanges, emptySelection, lostSeats, mergeSnapshot, selectionReducer, type Selection, type SelectionAction } from "@/features/seats/seat-state";

const hall = (cells: Array<[number, "free" | "held" | "sold", boolean?]>): SeatMap => ({
  eventId: 1,
  rows: [{ label: "A", seats: cells.map(([id, status, mine], index) => ({ id, number: index + 1, status, mine: mine ?? false })) }],
  myHoldIds: [],
});
const run = (actions: SelectionAction[], start: Selection = emptySelection): Selection => actions.reduce(selectionReducer, start);
const toggle = (seatId: number, status: "free" | "held" | "sold" = "free", mine = false): SelectionAction => ({ type: "toggle", seatId, status, mine });

describe("choosing seats (the optimistic part)", () => {
  it("a click marks the seat at once; a second click unmarks it", () => {
    expect(run([toggle(5)]).selected).toEqual([5]);
    expect(run([toggle(5), toggle(5)]).selected).toEqual([]);
  });

  it("quick repeated clicks never get out of step: N clicks on one seat leave it marked exactly when N is odd", () => {
    for (let clicks = 1; clicks <= 25; clicks++) {
      const state = run(Array.from({ length: clicks }, () => toggle(7)));
      expect(state.selected, `${clicks} clicks`).toEqual(clicks % 2 === 1 ? [7] : []);
    }
  });

  it("a mixed burst of clicks on several seats ends in the expected set, whatever the order", () => {
    const burst = [1, 2, 3, 2, 4, 1, 1, 5, 3].map((id) => toggle(id));
    expect(run(burst).selected.sort()).toEqual([1, 4, 5]);
  });

  it("a seat that is not free cannot be chosen, and the visitor is told", () => {
    for (const [status, mine] of [["held", false], ["sold", false], ["held", true], ["sold", true]] as const) {
      const state = run([toggle(9, status, mine)]);
      expect(state.selected).toEqual([]);
      expect(state.notice).toMatch(/not available/i);
    }
  });

  it(`no more than ${MAX_SEATS_PER_USER} seats can be chosen; the 7th is refused with a message and the others stay`, () => {
    const state = run(Array.from({ length: 10 }, (_, i) => toggle(i + 1)));
    expect(state.selected).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.notice).toMatch(/at most 6/);
    // and a seat can still be unmarked to make room
    expect(run([toggle(1)], state).selected).toEqual([2, 3, 4, 5, 6]);
  });

  it("choosing something valid clears an old message", () => {
    const refused = run([toggle(1, "sold")]);
    expect(run([toggle(2)], refused).notice).toBeNull();
  });
});

describe("rolling back when someone else was faster", () => {
  it("takes out only the seats that were lost, keeps the rest, and explains", () => {
    const state = run([{ type: "rollback", seatIds: [2, 4], message: "Someone else took them." }], { selected: [1, 2, 3, 4], notice: null });
    expect(state.selected).toEqual([1, 3]);
    expect(state.notice).toBe("Someone else took them.");
  });

  it("is a no-op (same object, no message) when none of the lost seats were chosen - no needless re-render", () => {
    const before: Selection = { selected: [1, 3], notice: null };
    expect(selectionReducer(before, { type: "rollback", seatIds: [8, 9], message: "x" })).toBe(before);
  });

  it("the whole story: choose seats, one is taken by another visitor (live update), the rollback removes just that one", () => {
    let map = hall([[1, "free"], [2, "free"], [3, "free"]]);
    let state = run([toggle(1), toggle(2), toggle(3)]);
    expect(lostSeats(map, state.selected)).toEqual([]);
    map = applyChanges(map, [{ seatId: 2, status: "held" }]); // another visitor holds seat 2
    const lost = lostSeats(map, state.selected);
    expect(lost).toEqual([2]);
    state = selectionReducer(state, { type: "rollback", seatIds: lost, message: "taken" });
    expect(state.selected).toEqual([1, 3]);
  });

  it("my own held seats are never reported as 'lost'", () => {
    expect(lostSeats(hall([[1, "held", true], [2, "free"]]), [1, 2])).toEqual([]);
  });
});

describe("live changes applied to the map", () => {
  it("updates exactly the seats named, leaves the others untouched (same objects)", () => {
    const before = hall([[1, "free"], [2, "free"], [3, "sold"]]);
    const after = applyChanges(before, [{ seatId: 2, status: "held" }]);
    expect(after.rows[0]?.seats.map((s) => s.status)).toEqual(["free", "held", "sold"]);
    expect(after.rows[0]?.seats[0]).toBe(before.rows[0]?.seats[0]);
    expect(after.rows[0]?.seats[2]).toBe(before.rows[0]?.seats[2]);
    expect(before.rows[0]?.seats[1]?.status).toBe("free"); // the old map is not modified
  });

  it("nothing to apply, or a change for an unknown seat, or one that repeats the current state: the map is returned as it was", () => {
    const map = hall([[1, "free"]]);
    expect(applyChanges(map, [])).toBe(map);
    expect(applyChanges(map, [{ seatId: 99, status: "sold" }]).rows[0]?.seats).toEqual(map.rows[0]?.seats);
    expect(applyChanges(map, [{ seatId: 1, status: "free" }]).rows[0]?.seats[0]).toBe(map.rows[0]?.seats[0]);
  });

  it("a seat that becomes free is nobody's; a seat of mine that is sold stays mine; one that changes hands is not mine", () => {
    const map = hall([[1, "held", true], [2, "held", true], [3, "free"]]);
    const after = applyChanges(map, [{ seatId: 1, status: "free" }, { seatId: 2, status: "sold" }, { seatId: 3, status: "held" }]);
    const [one, two, three] = after.rows[0]?.seats ?? [];
    expect(one).toMatchObject({ status: "free", mine: false });
    expect(two).toMatchObject({ status: "sold", mine: true });
    expect(three).toMatchObject({ status: "held", mine: false });
  });

  it("several changes to the same seat in one batch: the last one wins", () => {
    const after = applyChanges(hall([[1, "free"]]), [{ seatId: 1, status: "held" }, { seatId: 1, status: "sold" }]);
    expect(after.rows[0]?.seats[0]?.status).toBe("sold");
  });
});

describe("reconnecting: the full map plus changes that raced it", () => {
  it("changes that arrived while the map was on its way are applied ON TOP of it", () => {
    // the map was read when seat 1 was free; while it travelled, seat 1 got held. The result must say held.
    const snapshot = hall([[1, "free"], [2, "free"]]);
    const merged = mergeSnapshot(snapshot, [{ seatId: 1, status: "held" }]);
    expect(merged.rows[0]?.seats.map((s) => s.status)).toEqual(["held", "free"]);
  });

  it("with no raced changes the snapshot is used as it is", () => {
    const snapshot = hall([[1, "sold"]]);
    expect(mergeSnapshot(snapshot, [])).toBe(snapshot);
  });
});
