import { expect, test } from "@playwright/test";
import { freeSeats, newPerson, openSeats, randomEvent } from "./helpers";

test("from the catalog to an order: register, choose seats, hold, pay - and the header counter, the hall and the orders all agree", async ({ page, request }) => {
  const person = newPerson("buyer");

  // register through the form
  await page.goto("/register");
  await page.getByLabel("Email").fill(person.email);
  await page.getByLabel("Password").fill(person.password);
  await page.getByRole("button", { name: "Register" }).click();
  await expect(page.getByTestId("user-email")).toHaveText(person.email.toLowerCase());
  await expect(page.getByTestId("orders-count")).toHaveText("0");

  // catalog -> an event -> its seats
  const event = await randomEvent(request);
  await page.goto("/");
  await page.getByLabel("Search by title").fill(event.title);
  await page.getByRole("link", { name: event.title }).first().click();
  await expect(page.getByTestId("event-title")).toContainText(event.title.split(":")[0] as string);
  await page.getByRole("link", { name: "Choose seats" }).click();
  await expect(page.getByTestId("seat-grid")).toBeVisible();

  // choose two seats with the mouse: they are marked at once
  const seats = freeSeats(page);
  const first = await seats.nth(0).getAttribute("data-seat");
  await seats.nth(0).click();
  await expect(page.locator(`[data-seat="${first}"]`)).toHaveAttribute("data-status", "chosen");
  const second = await seats.nth(0).getAttribute("data-seat"); // the next free one
  await seats.nth(0).click();
  await expect(page.getByTestId("selection-summary")).toContainText(`${first}, ${second}`);

  await page.getByTestId("hold-button").click();
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(page.getByTestId("checkout-seats")).toContainText(`${first}, ${second}`);
  await expect(page.getByTestId("checkout-timer")).toContainText(/\b(09|10):\d\d\b/);

  // pay: the counter goes up at once, and stays up
  await page.getByTestId("pay-button").click();
  await expect(page).toHaveURL(/\/me\/orders/);
  await expect(page.getByTestId("orders-count")).toHaveText("1");
  await expect(page.getByTestId("orders").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("orders")).toContainText(`${first}, ${second}`);

  // the hall now shows them as bought, and as mine
  await openSeats(page, event.id);
  await expect(page.locator(`[data-seat="${first}"]`)).toHaveAttribute("data-status", "mine");
  await expect(page.locator(`[data-seat="${second}"]`)).toHaveAttribute("data-status", "mine");
  // the legend promises a tick for your own seats: it must really be on them
  await expect(page.locator(`[data-seat="${first}"]`)).toHaveText("✓");
  await expect(page.locator(`[data-seat="${second}"]`)).toHaveText("✓");
});

test("cancelling a hold frees the seats at once", async ({ page, context, request }) => {
  const person = newPerson("canceller");
  await context.request.post("/api/auth/register", { data: person });
  const event = await randomEvent(request);
  await openSeats(page, event.id);
  const seat = await freeSeats(page).first().getAttribute("data-seat");
  await page.locator(`[data-seat="${seat}"]`).click();
  await page.getByTestId("hold-button").click();
  await expect(page).toHaveURL(/\/checkout\//);

  await page.getByTestId("cancel-button").click();
  await expect(page).toHaveURL(new RegExp(`/events/${event.id}/seats`));
  await expect(page.getByTestId("seat-grid")).toBeVisible();
  await expect(page.locator(`[data-seat="${seat}"]`)).toHaveAttribute("data-status", "free");
  await expect(page.getByTestId("orders-count")).toHaveText("0");
});

test("seats can be chosen with the keyboard alone", async ({ page, context, request }) => {
  await context.request.post("/api/auth/register", { data: newPerson("keys") });
  const event = await randomEvent(request);
  await openSeats(page, event.id);

  // a free seat whose right-hand neighbour is also free (earlier runs may have sold seats here)
  const start = page.locator('[data-testid="seat-grid"] button[data-status="free"]:has(+ button[data-status="free"])').first();
  const startName = await start.getAttribute("data-seat");
  await start.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(`[data-seat="${startName}"]`)).toHaveAttribute("data-status", "chosen");

  await page.keyboard.press("ArrowRight");
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-seat"));
  expect(focused).not.toBe(startName);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("selection-summary")).toContainText("Chosen (2)");

  await page.keyboard.press("Space"); // pressing again unmarks
  await expect(page.getByTestId("selection-summary")).toContainText("Chosen (1)");
});

test("no more than 6 seats can be chosen", async ({ page, context, request }) => {
  await context.request.post("/api/auth/register", { data: newPerson("limit") });
  const event = await randomEvent(request);
  await openSeats(page, event.id);
  for (let i = 0; i < 7; i++) await freeSeats(page).nth(i).click();
  await expect(page.getByTestId("selection-summary")).toContainText("Chosen (6)");
  await expect(page.getByTestId("seat-notice")).toContainText("at most 6");
});

test("holding needs a login: a visitor is sent to the login page and comes back", async ({ page, request }) => {
  const event = await randomEvent(request);
  await openSeats(page, event.id);
  await freeSeats(page).first().click();
  await page.getByRole("button", { name: "Log in to hold seats" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fevents%2F\d+%2Fseats/);
});
