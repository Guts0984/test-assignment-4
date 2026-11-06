import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { freeSeats, newPerson, openSeats, randomEvent, registerInContext } from "./helpers";

// Optimistic updates: the screen changes at once, and goes back if the server says no.
// A request is held back (or made to fail) on purpose, so there is a moment in which only the optimistic state can be seen.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A logged-in user with a 2-seat hold, standing on the checkout page. */
async function startCheckout(page: Page, context: BrowserContext, request: Parameters<typeof randomEvent>[0]): Promise<{ holdId: string; eventId: number }> {
  await registerInContext(context, newPerson("optimistic"));
  const event = await randomEvent(request);
  await openSeats(page, event.id);
  await freeSeats(page).nth(0).click();
  await freeSeats(page).nth(0).click();
  await page.getByTestId("hold-button").click();
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(page.getByTestId("pay-button")).toBeVisible();
  await expect(page.getByTestId("orders-count")).toHaveText("0"); // the header knows the orders (none yet)
  return { holdId: page.url().split("/checkout/")[1] as string, eventId: event.id };
}

const holdStatus = async (context: BrowserContext, holdId: string): Promise<string> =>
  ((await (await context.request.get(`/api/holds/${holdId}`)).json()) as { hold: { status: string } }).hold.status;

test("paying: the orders counter goes up at once, before the server has answered", async ({ page, context, request }) => {
  await startCheckout(page, context, request);
  await page.route("**/api/holds/*/pay", async (route) => {
    await sleep(2500); // the server is slow
    await route.continue();
  });
  const clicked = Date.now();
  await page.getByTestId("pay-button").click();
  await expect(page.getByTestId("orders-count")).toHaveText("1", { timeout: 1500 });
  expect(Date.now() - clicked, "the counter moved while the request was still waiting").toBeLessThan(2000);
  await expect(page).toHaveURL(/\/me\/orders/, { timeout: 10_000 }); // and the payment then really goes through
  await expect(page.getByTestId("orders-count")).toHaveText("1");
});

test("paying fails: the counter goes back, a message is shown, nothing is paid", async ({ page, context, request }) => {
  const { holdId } = await startCheckout(page, context, request);
  await page.route("**/api/holds/*/pay", async (route) => {
    await sleep(2000);
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL_ERROR", message: "Something went wrong on our side." }) });
  });
  await page.getByTestId("pay-button").click();
  await expect(page.getByTestId("orders-count")).toHaveText("1", { timeout: 1500 }); // optimistic ...
  await expect(page.getByTestId("orders-count")).toHaveText("0", { timeout: 10_000 }); // ... and rolled back
  await expect(page.getByRole("alert").filter({ hasText: /went wrong|try again/i })).toBeVisible();
  await expect(page).toHaveURL(/\/checkout\//); // still on the booking, which can be paid again
  await expect(page.getByTestId("pay-button")).toBeEnabled();
  expect(await holdStatus(context, holdId)).toBe("active");
});

test("cancelling: the booking looks cancelled at once, before the server has answered", async ({ page, context, request }) => {
  const { holdId } = await startCheckout(page, context, request);
  await page.route("**/api/holds/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await sleep(2500);
    await route.continue();
  });
  await page.getByTestId("cancel-button").click();
  await expect(page.getByText("This booking was cancelled.")).toBeVisible({ timeout: 1500 });
  expect(await holdStatus(context, holdId), "the server has not cancelled it yet").toBe("active");
  await expect(page).toHaveURL(/\/events\/\d+\/seats/, { timeout: 10_000 }); // then it really is cancelled
  expect(await holdStatus(context, holdId)).toBe("cancelled");
});

test("cancelling fails: the booking is put back, with a message", async ({ page, context, request }) => {
  const { holdId } = await startCheckout(page, context, request);
  await page.route("**/api/holds/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    await sleep(2000);
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL_ERROR", message: "Something went wrong on our side." }) });
  });
  await page.getByTestId("cancel-button").click();
  await expect(page.getByText("This booking was cancelled.")).toBeVisible({ timeout: 1500 }); // optimistic ...
  await expect(page.getByText("This booking was cancelled.")).toBeHidden({ timeout: 10_000 }); // ... and rolled back
  await expect(page.getByTestId("pay-button")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /went wrong|try again/i })).toBeVisible();
  expect(await holdStatus(context, holdId)).toBe("active");
});

test("clicking a seat again and again quickly ends in a consistent state, and a fast double click on Pay pays once", async ({ page, context, request }) => {
  await registerInContext(context, newPerson("rapid"));
  const event = await randomEvent(request);
  await openSeats(page, event.id);
  const seat = (await freeSeats(page).first().getAttribute("data-seat")) as string;
  const button = page.locator(`[data-seat="${seat}"]`);
  for (let i = 0; i < 9; i++) await button.click({ delay: 0 }); // an odd number of clicks: chosen
  await expect(button).toHaveAttribute("data-status", "chosen");
  await expect(page.getByTestId("selection-summary")).toContainText(seat);
  await button.click(); // an even number now: free again
  await expect(button).toHaveAttribute("data-status", "free");
  await expect(page.getByTestId("hold-button")).toBeDisabled();

  await button.click();
  await page.getByTestId("hold-button").click();
  await expect(page).toHaveURL(/\/checkout\//);
  await page.getByTestId("pay-button").dblclick();
  await expect(page).toHaveURL(/\/me\/orders/);
  await expect(page.getByTestId("orders-count")).toHaveText("1");
  await expect(page.getByTestId("orders").getByRole("listitem")).toHaveCount(1); // one order, not two
});
