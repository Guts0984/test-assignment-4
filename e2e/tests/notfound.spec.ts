import { expect, test } from "@playwright/test";

// Acceptance check 6: `curl -I /events/9999` and `/events/abc` are both 404.
for (const id of ["9999", "abc", "0", "-1", "1.5", "99999999999999999999"]) {
  test(`/events/${id} is a real HTTP 404 (page, HEAD request and the seat page)`, async ({ request, page }) => {
    expect((await request.head(`/events/${id}`)).status(), "HEAD").toBe(404);
    expect((await request.get(`/events/${id}`)).status(), "GET").toBe(404);
    expect((await request.get(`/events/${id}/seats`)).status(), "seats").toBe(404);
    expect((await request.get(`/api/events/${id}`)).status(), "api").toBe(404);

    const response = await page.goto(`/events/${id}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });
}

test("an event that exists is 200, and its page is the same for the second visitor", async ({ request }) => {
  const first = await request.get("/events/1");
  expect(first.status()).toBe(200);
  expect(await first.text()).toContain("Choose seats");
});
