import { expect, test } from "@playwright/test";
import { newPerson, openSeats, randomEvent, registerInContext } from "./helpers";

test("two browsers want the same seat: one gets it, the other is rolled back with a message, and both halls end up the same (acceptance check 9)", async ({ browser, request }) => {
  const event = await randomEvent(request);
  const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()];
  const [a, b] = [await ctxA.newPage(), await ctxB.newPage()];
  await registerInContext(ctxA, newPerson("ann"));
  await registerInContext(ctxB, newPerson("ben"));
  await Promise.all([openSeats(a, event.id), openSeats(b, event.id)]);

  const seat = await a.locator('[data-testid="seat-grid"] button[data-status="free"]').first().getAttribute("data-seat");
  const cell = (page: typeof a) => page.locator(`[data-seat="${seat}"]`);

  // Ben chooses the seat first (marked on his side at once) ...
  await cell(b).click();
  await expect(cell(b)).toHaveAttribute("data-status", "chosen");
  // ... but Ann holds it before Ben does.
  await cell(a).click();
  await a.getByTestId("hold-button").click();
  await expect(a).toHaveURL(/\/checkout\//);

  // Ben's hall changes by itself (Socket.IO): the seat shows as taken, his mark is rolled back, and he is told why.
  await expect(cell(b)).toHaveAttribute("data-status", "held");
  await expect(b.getByTestId("seat-notice")).toContainText("taken by someone else");
  await expect(b.getByTestId("selection-summary")).toContainText("Choose up to 6 seats");

  // Ann pays: Ben sees "sold" without reloading.
  await a.getByTestId("pay-button").click();
  await expect(a).toHaveURL(/\/me\/orders/);
  await expect(cell(b)).toHaveAttribute("data-status", "sold");

  // Both halls agree after a fresh load too.
  // The server's own answer to each of them agrees: the seat is Ann's (and so "mine" for her) and sold for Ben.
  const statusFor = async (context: typeof ctxA) => {
    const map = (await (await context.request.get(`/api/events/${event.id}/seats`)).json()) as { rows: Array<{ label: string; seats: Array<{ number: number; status: string; mine: boolean }> }> };
    const found = map.rows.flatMap((row) => row.seats.map((cellInfo) => ({ name: `${row.label}${cellInfo.number}`, ...cellInfo }))).find((cellInfo) => cellInfo.name === seat);
    return found ? `${found.status}${found.mine ? ":mine" : ""}` : "missing";
  };
  expect(await statusFor(ctxA)).toBe("sold:mine");
  expect(await statusFor(ctxB)).toBe("sold");
  await ctxA.close();
  await ctxB.close();
});

test("the same race when the loser has no live connection: the server refuses (409), the mark is rolled back and the hall refreshes", async ({ browser, request }) => {
  const event = await randomEvent(request);
  const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()];
  const [a, b] = [await ctxA.newPage(), await ctxB.newPage()];
  await registerInContext(ctxA, newPerson("cara"));
  await registerInContext(ctxB, newPerson("dan"));

  // Dan's live connection is cut: his page cannot hear about Cara's choice.
  await b.routeWebSocket(/socket\.io/, (ws) => ws.close());
  await b.goto(`/events/${event.id}/seats`);
  await expect(b.getByTestId("seat-grid")).toBeVisible();
  await openSeats(a, event.id);

  const seat = await a.locator('[data-testid="seat-grid"] button[data-status="free"]').first().getAttribute("data-seat");
  await b.locator(`[data-seat="${seat}"]`).click();
  await expect(b.locator(`[data-seat="${seat}"]`)).toHaveAttribute("data-status", "chosen");

  await a.locator(`[data-seat="${seat}"]`).click();
  await a.getByTestId("hold-button").click();
  await expect(a).toHaveURL(/\/checkout\//);

  await b.getByTestId("hold-button").click(); // Dan tries: too late
  await expect(b.getByTestId("seat-notice")).toContainText("Someone else just took");
  await expect(b.locator(`[data-seat="${seat}"]`)).toHaveAttribute("data-status", "held"); // his map refreshed
  await expect(b).toHaveURL(new RegExp(`/events/${event.id}/seats`)); // and he is still on the hall page
  await ctxA.close();
  await ctxB.close();
});

test("double-clicking 'Hold' makes one hold, not two", async ({ page, context, request }) => {
  await registerInContext(context, newPerson("dbl"));
  const event = await randomEvent(request);
  await openSeats(page, event.id);
  const seat = await page.locator('[data-testid="seat-grid"] button[data-status="free"]').first().getAttribute("data-seat");
  await page.locator(`[data-seat="${seat}"]`).click();
  await page.getByTestId("hold-button").dblclick();
  await expect(page).toHaveURL(/\/checkout\//);
  const holds = await context.request.get(`/api/events/${event.id}/seats`);
  const map = (await holds.json()) as { myHoldIds: string[] };
  expect(map.myHoldIds).toHaveLength(1);
});
