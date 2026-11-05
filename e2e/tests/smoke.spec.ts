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

test("the catalog: filters live in the address, search is by title, 'Show more' loads the next page", async ({ page }) => {
  await page.goto("/");
  const items = page.getByTestId("event-list").locator("> li");
  await expect(items).toHaveCount(20);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(items).toHaveCount(40);

  await page.getByLabel("City").selectOption("Kazan");
  await expect(page).toHaveURL(/city=Kazan/);
  await expect(items.first()).toBeVisible();
  for (const text of await items.allTextContents()) expect(text).toContain("Kazan");

  await page.getByLabel("Search by title").fill("Concert");
  await expect(page).toHaveURL(/q=Concert/);
  await expect(items.first()).toContainText("Concert");
  for (const title of await items.locator("h2").allTextContents()) expect(title.toLowerCase()).toContain("concert");

  // a reload keeps the filters
  await page.reload();
  await expect(page.getByLabel("Search by title")).toHaveValue("Concert");
  await expect(page.getByLabel("City")).toHaveValue("Kazan");

  await page.getByLabel("Search by title").fill("no such event title 12345");
  await expect(page.getByText("No upcoming events match these filters.")).toBeVisible();
});
