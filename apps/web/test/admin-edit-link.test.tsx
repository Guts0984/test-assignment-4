// @vitest-environment jsdom
import type { PublicUser } from "@app/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/lib/client-api", () => ({ apiRequest: () => new Promise(() => undefined) }));

const { AdminEditLink } = await import("@/features/admin/admin-edit-link");
const { queryKeys } = await import("@/shared/lib/query-keys");

afterEach(cleanup);

function show(me: PublicUser | null | undefined) {
  const client = new QueryClient();
  if (me !== undefined) client.setQueryData(queryKeys.me, me);
  render(
    <QueryClientProvider client={client}>
      <AdminEditLink eventId={42} />
    </QueryClientProvider>,
  );
}

const person = (role: "ADMIN" | "USER"): PublicUser => ({ id: "00000000-0000-4000-8000-000000000001", email: "x@example.com", role: role === "ADMIN" ? "admin" : "user" });

describe("the edit link", () => {
  it("is shown to the administrator, pointing at that event's form", () => {
    show(person("ADMIN"));
    expect(screen.getByRole("link", { name: "Edit event" }).getAttribute("href")).toBe("/admin/events/42");
  });

  it("is not shown to an ordinary user, to a visitor, or while we do not yet know who is looking", () => {
    for (const me of [person("USER"), null, undefined]) {
      cleanup();
      show(me);
      expect(screen.queryByRole("link", { name: "Edit event" }), String(me && (me as PublicUser).role)).toBeNull();
    }
  });
});
