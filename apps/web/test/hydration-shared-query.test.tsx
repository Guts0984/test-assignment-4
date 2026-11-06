// @vitest-environment jsdom
import type { OrderList, PublicUser } from "@app/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined, refresh: () => undefined }) }));
// No network: a request never answers. What the components see comes only from the query cache we prepare.
vi.mock("@/shared/lib/client-api", () => ({ apiRequest: () => new Promise(() => undefined) }));

const { UserMenu } = await import("@/features/auth/user-menu");
const { OrdersList } = await import("@/features/orders/orders-list");
const { queryKeys } = await import("@/shared/lib/query-keys");

// `act` needs to know it is in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user: PublicUser = { id: "00000000-0000-4000-8000-000000000001", email: "someone@example.com", role: "user" };
const noOrders: OrderList = { items: [] };

function Page({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <header>
        <UserMenu />
      </header>
      <main>
        <OrdersList />
      </main>
    </QueryClientProvider>
  );
}

let container: HTMLElement | undefined;
afterEach(() => {
  container?.remove();
  container = undefined;
});

/**
 * The page /me/orders: the header and the list read the SAME query. In a slow-to-hydrate browser (WebKit in CI) the
 * header's request is answered before the list has been hydrated, so the list's very first browser render already has
 * data - while the server sent a "loading" placeholder. React then reports error #418 (server HTML != browser render).
 * Here the shared answer is put in the cache BEFORE hydration, which is that situation exactly.
 */
describe("hydration when another component has already filled the query", () => {
  it("hydrates the page of a logged-in user without any mismatch, and then shows the real data", async () => {
    const serverHtml = renderToString(<Page client={new QueryClient()} />);
    expect(serverHtml, "the server draws the loading placeholder").toContain("Loading your orders");

    const client = new QueryClient();
    client.setQueryData(queryKeys.me, user);
    client.setQueryData(queryKeys.orders, noOrders);

    container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);

    const problems: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void problems.push(args.map(String).join(" ")));
    await act(async () => {
      hydrateRoot(container as HTMLElement, <Page client={client} />, { onRecoverableError: (error) => problems.push(String(error)) });
    });
    await act(async () => undefined);
    errors.mockRestore();

    expect(problems, problems.join("\n")).toEqual([]);
    // and after hydration the real data is there
    expect(container.textContent).toContain("You have no orders yet");
    expect(container.textContent).toContain(user.email);
  });
});
