import { expect, test } from "@playwright/test";

test("nginx answers, the api is behind /api, and the site renders", async ({ page, request }) => {
  expect((await request.get("/healthz")).status()).toBe(200);

  const api = await request.get("/api/health");
  expect(api.status()).toBe(200);
  expect(await api.json()).toEqual({ status: "ok" });
  expect((await request.get("/api/ready")).status()).toBe(200);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Upcoming events" })).toBeVisible();
  await expect(page.getByTestId("event-list").locator("> li")).toHaveCount(20);
});

test("a missing api path is a 404 from the api, not a 5xx", async ({ request }) => {
  expect((await request.get("/api/nothing-here")).status()).toBe(404);
});

test("the API documentation is at /docs", async ({ request }) => {
  const docs = await request.get("/docs/");
  expect(docs.status()).toBe(200);
  expect(await docs.text()).toContain("swagger");
});

// Each card is its own test (a fresh browser each time). The title link covers its whole card, so a click anywhere on the card
// must open the event of THAT card.
for (const index of [0, 7, 19]) {
  test(`the catalog: clicking anywhere on card ${index + 1} opens that card's event, not another one`, async ({ page }) => {
    await page.goto("/");
    const cards = page.getByTestId("event-list").locator("> li");
    await expect(cards).toHaveCount(20);
    const card = cards.nth(index);
    const href = await card.getByRole("link").getAttribute("href");
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    // on the card's text, not on the title link itself
    await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) * 0.8, (box?.y ?? 0) + (box?.height ?? 0) * 0.75);
    await expect(page).toHaveURL(new RegExp(`${href}$`));
  });
}

test("the catalog: filters live in the address, search is by title, 'Show more' loads the next page", async ({ page }) => {
  await page.goto("/");
  const items = page.getByTestId("event-list").locator("> li");
  await expect(items).toHaveCount(20);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(items).toHaveCount(40);

  await page.getByLabel("City").selectOption("Chicago");
  await expect(page).toHaveURL(/city=Chicago/);
  await expect(items.first()).toBeVisible();
  for (const text of await items.allTextContents()) expect(text).toContain("Chicago");

  await page.getByLabel("Search by title").fill("Concert");
  await expect(page).toHaveURL(/q=Concert/);
  await expect(items.first()).toContainText("Concert");
  for (const title of await items.locator("h2").allTextContents()) expect(title.toLowerCase()).toContain("concert");

  // a reload keeps the filters
  await page.reload();
  await expect(page.getByLabel("Search by title")).toHaveValue("Concert");
  await expect(page.getByLabel("City")).toHaveValue("Chicago");

  await page.getByLabel("Search by title").fill("no such event title 12345");
  await expect(page.getByText("No upcoming events match these filters.")).toBeVisible();
});
