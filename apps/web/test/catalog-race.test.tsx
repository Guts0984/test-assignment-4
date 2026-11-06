// @vitest-environment jsdom
import type { EventDto, EventList } from "@app/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- a pretend address bar, so the catalog's filters in the URL really change and re-render it ----
let url = new URLSearchParams();
const listeners = new Set<() => void>();
const setUrl = (next: string) => {
  url = new URLSearchParams(next.includes("?") ? next.slice(next.indexOf("?")) : "");
  listeners.forEach((listener) => listener());
};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: setUrl, push: setUrl }),
  usePathname: () => "/",
  useSearchParams: () => useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => url, () => url),
}));

// ---- a pretend server whose answers we release by hand, in any order ----
type Pending = { query: URLSearchParams; resolve: (list: EventList) => void; aborted: boolean };
let pending: Pending[] = [];
vi.mock("@/shared/lib/client-api", () => ({
  apiRequest: (path: string, init: { signal?: AbortSignal } = {}) =>
    new Promise<EventList>((resolve) => {
      const entry: Pending = { query: new URLSearchParams(path.slice(path.indexOf("?"))), resolve, aborted: false };
      init.signal?.addEventListener("abort", () => (entry.aborted = true));
      pending.push(entry);
    }),
}));

const { Catalog } = await import("@/features/events/catalog");
const { Providers } = await import("@/shared/providers");

const event = (id: number, title: string): EventDto => ({ id, title, description: "", city: "Chicago", startsAt: "2026-12-01T18:00:00.000Z", hall: { id: 1, name: "Main Hall" }, version: 1 });
const listOf = (...titles: string[]): EventList => ({ items: titles.map((title, i) => event(i + 1, title)), nextCursor: null });
const answerFor = (search: string) => pending.find((p) => p.query.get("q") === search);

/** Rendered inside the real Providers, so the query client has exactly the settings the site uses. */
function renderCatalog(initialPage: EventList | null = listOf("Initial event")) {
  return render(
    <Providers>
      <Catalog initialPage={initialPage} />
    </Providers>,
  );
}

beforeEach(() => {
  url = new URLSearchParams();
  pending = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the catalog: an old answer never replaces a newer one", () => {
  it("shows the list it was given first, with no request", () => {
    renderCatalog();
    expect(screen.getByText("Initial event")).toBeTruthy();
    expect(pending).toHaveLength(0);
  });

  it("typing quickly sends ONE request, for the final text (after the pause), not one per letter", async () => {
    const user = userEvent.setup();
    renderCatalog();
    await user.type(screen.getByLabelText("Search by title"), "jazz");
    await waitFor(() => expect(pending.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(pending.map((p) => p.query.get("q"))).toEqual(["jazz"]);
  });

  it("search 'ja' is slow, search 'jazz' is fast: when 'ja' finally answers, 'jazz' is still what is shown", async () => {
    const user = userEvent.setup();
    renderCatalog();
    const box = screen.getByLabelText("Search by title");

    await user.type(box, "ja");
    await waitFor(() => expect(answerFor("ja")).toBeDefined(), { timeout: 2000 });
    await user.type(box, "zz"); // the visitor goes on typing while "ja" is still being answered
    await waitFor(() => expect(answerFor("jazz")).toBeDefined(), { timeout: 2000 });

    await act(async () => answerFor("jazz")?.resolve(listOf("Jazz Night", "Jazz Festival"))); // the newer search answers first ...
    await waitFor(() => expect(screen.getByText("Jazz Night")).toBeTruthy());

    await act(async () => answerFor("ja")?.resolve(listOf("Japanese Theatre"))); // ... and the older one limps in afterwards
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.queryByText("Japanese Theatre")).toBeNull();
    expect(screen.getByText("Jazz Night")).toBeTruthy();
    expect(screen.getByText("Jazz Festival")).toBeTruthy();
  });

  it("the older request is cancelled when it is no longer wanted", async () => {
    const user = userEvent.setup();
    renderCatalog();
    const box = screen.getByLabelText("Search by title");
    await user.type(box, "ro");
    await waitFor(() => expect(answerFor("ro")).toBeDefined(), { timeout: 2000 });
    await user.type(box, "ck");
    await waitFor(() => expect(answerFor("rock")).toBeDefined(), { timeout: 2000 });
    await waitFor(() => expect(answerFor("ro")?.aborted).toBe(true));
  });

  it("going back to a search seen before shows its saved answer at once", async () => {
    const user = userEvent.setup();
    renderCatalog();
    const box = screen.getByLabelText("Search by title");
    await user.type(box, "opera");
    await waitFor(() => expect(answerFor("opera")).toBeDefined(), { timeout: 2000 });
    await act(async () => answerFor("opera")?.resolve(listOf("Opera: Aurora")));
    await waitFor(() => expect(screen.getByText("Opera: Aurora")).toBeTruthy());

    await user.clear(box);
    await waitFor(() => expect(screen.getByText("Initial event")).toBeTruthy(), { timeout: 2000 }); // the unfiltered list is kept
    await user.type(box, "opera");
    await waitFor(() => expect(screen.getByText("Opera: Aurora")).toBeTruthy(), { timeout: 2000 });
    expect(pending.filter((p) => p.query.get("q") === "opera").length).toBeLessThanOrEqual(2); // not asked again from scratch for nothing
  });

  it("'Show more' loads the next page with the cursor and appends it", async () => {
    const user = userEvent.setup();
    renderCatalog({ items: [event(1, "First page event")], nextCursor: "CURSOR1" });
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]?.query.get("cursor")).toBe("CURSOR1");
    await act(async () => pending[0]?.resolve({ items: [event(2, "Second page event")], nextCursor: null }));
    await waitFor(() => expect(screen.getByText("Second page event")).toBeTruthy());
    expect(screen.getByText("First page event")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});
