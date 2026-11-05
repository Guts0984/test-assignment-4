import { expect, test } from "@playwright/test";

test("nginx answers, the api is behind /api, and the site renders", async ({ page, request }) => {
  expect((await request.get("/healthz")).status()).toBe(200);

  const api = await request.get("/api/health");
  expect(api.status()).toBe(200);
  expect(await api.json()).toEqual({ status: "ok" });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Event Tickets" })).toBeVisible();
});

test("a missing api path is a 404 from the api, not a 5xx", async ({ request }) => {
  expect((await request.get("/api/nothing-here")).status()).toBe(404);
});
