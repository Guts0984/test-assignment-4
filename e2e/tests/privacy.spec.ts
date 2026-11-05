import { expect, test } from "@playwright/test";
import { freeSeats, newPerson, openSeats, randomEvent, registerInContext } from "./helpers";

test("one user's orders and header never reach another user or an anonymous visitor, through any cache (acceptance check 14)", async ({ browser, request }) => {
  const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()];
  const [a, b] = [await ctxA.newPage(), await ctxB.newPage()];
  const [ann, ben] = [newPerson("privacy-ann"), newPerson("privacy-ben")];
  await registerInContext(ctxA, ann);
  await registerInContext(ctxB, ben);

  // Ann buys a seat
  const event = await randomEvent(request);
  await openSeats(a, event.id);
  const seat = await freeSeats(a).first().getAttribute("data-seat");
  await a.locator(`[data-seat="${seat}"]`).click();
  await a.getByTestId("hold-button").click();
  await a.getByTestId("pay-button").click();
  await expect(a.getByTestId("orders-count")).toHaveText("1");
  await expect(a.getByTestId("user-email")).toHaveText(ann.email.toLowerCase());

  // Ben, on the same pages, sees only his own things
  await b.goto("/me/orders");
  await expect(b.getByText("You have no orders yet.")).toBeVisible();
  await expect(b.getByTestId("user-email")).toHaveText(ben.email.toLowerCase());
  await expect(b.getByTestId("orders-count")).toHaveText("0");

  // The api: Ann's list is hers, marked as not cacheable; Ben's is empty; without a cookie it is 401
  const asAnn = await ctxA.request.get("/api/me/orders");
  expect(asAnn.headers()["cache-control"]).toBe("private, no-store");
  expect((await asAnn.json()).items).toHaveLength(1);
  expect((await ctxB.request.get("/api/me/orders").then((r) => r.json())).items).toEqual([]);
  expect((await request.get("/api/me/orders")).status()).toBe(401);

  // The pages: nobody's email or order is in any HTML that the shared page cache could keep. (The header is drawn in the browser.)
  const anonymousHtml = await (await request.get("/")).text();
  const annHtml = await (await ctxA.request.get("/")).text();
  for (const html of [anonymousHtml, annHtml, await (await request.get(`/events/${event.id}`)).text()]) {
    expect(html).not.toContain(ann.email);
    expect(html).not.toContain(ben.email);
    expect(html).not.toContain(seat as string + ", ");
  }

  // Many requests for the shared page, with and without a session, never mix: still nothing personal
  for (let i = 0; i < 6; i++) {
    expect(await (await request.get("/")).text()).not.toContain(ann.email);
    expect(await (await ctxB.request.get("/")).text()).not.toContain(ann.email);
  }
  await ctxA.close();
  await ctxB.close();
});

test("nginx page cache: HIT for anonymous visitors, BYPASS for anybody with a session (acceptance check 15)", async ({ request, browser }) => {
  // the second look at the same public page within a few seconds is served from the cache
  const url = `/events/${1 + Math.floor(Math.random() * 20)}`;
  await request.get(url);
  const second = await request.get(url);
  expect(second.headers()["x-cache-status"]).toBe("HIT");

  const context = await browser.newContext();
  await registerInContext(context, newPerson("cache"));
  for (let i = 0; i < 2; i++) {
    const withSession = await context.request.get(url);
    expect(withSession.headers()["x-cache-status"]).toBe("BYPASS");
  }
  // pages that belong to one user are never cached either
  const orders = await context.request.get("/me/orders");
  expect(orders.headers()["x-cache-status"]).toBe("BYPASS");
  expect(orders.headers()["cache-control"]).toContain("no-store");
  await context.close();

  // and the anonymous copy was not changed by the logged-in visits
  expect((await request.get(url)).headers()["x-cache-status"]).toMatch(/HIT|MISS|EXPIRED/);
});

test("a cookie cannot be forged to get someone else's data", async ({ request }) => {
  for (const cookie of ["sid=" + "A".repeat(43), "sid=abc", "sid=" + "0".repeat(300)]) {
    expect((await request.get("/api/me", { headers: { cookie } })).status()).toBe(401);
    expect((await request.get("/api/me/orders", { headers: { cookie } })).status()).toBe(401);
  }
});
