import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test";
import { ADMIN, ALICE, loginInContext, newPerson, registerInContext } from "./helpers";

type Event = { id: number; title: string; description: string; version: number };

async function adminRequest(playwright: PlaywrightWorkerArgs["playwright"]): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL: process.env["BASE_URL"] ?? "http://localhost:8080" });
  const reply = await context.post("/api/auth/login", { data: ADMIN });
  expect(reply.status(), "the administrator can log in (is the seed password in .env?)").toBe(200);
  return context;
}

/** An event the other tests do not use (the last of the list), so edits here disturb nobody. */
const EVENT_ID = 100;

test("the edit form saves, and the card and the list show the change within 5 seconds (acceptance check 5, form)", async ({ page, context, request }) => {
  await loginInContext(context, ADMIN);
  const before = (await (await request.get(`/api/events/${EVENT_ID}`)).json()) as Event;
  const title = `Edited by the form ${Date.now().toString(36)}`;

  await page.goto(`/admin/events/${EVENT_ID}`);
  await expect(page.getByLabel("Title")).toHaveValue(before.title);
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("saved")).toBeVisible();

  const started = Date.now();
  // the card (served from a page cache that lives at most 5 seconds)
  await expect.poll(async () => (await request.get(`/events/${EVENT_ID}`)).text(), { timeout: 5000, intervals: [250] }).toContain(title);
  // the list
  await expect.poll(async () => JSON.stringify(await (await request.get(`/api/events?q=${encodeURIComponent(title)}`)).json()), { timeout: 5000, intervals: [250] }).toContain(title);
  await page.goto("/");
  await page.getByLabel("Search by title").fill(title);
  await expect(page.getByRole("link", { name: title })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(15_000);
});

test("a change made straight through the API shows up in the card and the list within 5 seconds (acceptance check 5, API)", async ({ playwright, request }) => {
  const admin = await adminRequest(playwright);
  const current = (await (await request.get(`/api/events/${EVENT_ID}`)).json()) as Event;
  const title = `Edited by the API ${Date.now().toString(36)}`;
  const patch = await admin.patch(`/api/events/${EVENT_ID}`, { data: { title, version: current.version } });
  expect(patch.status()).toBe(200);

  await expect.poll(async () => (await request.get(`/events/${EVENT_ID}`)).text(), { timeout: 5500, intervals: [250] }).toContain(title);
  await expect.poll(async () => JSON.stringify(await (await request.get(`/api/events?q=${encodeURIComponent(title)}`)).json()), { timeout: 5000, intervals: [250] }).toContain(title);
  await admin.dispose();
});

test("two editors: the one who saves second sees the SAVED version next to what they typed, and loses nothing", async ({ page, context, playwright, request }) => {
  await loginInContext(context, ADMIN);
  const admin = await adminRequest(playwright);
  const current = (await (await request.get(`/api/events/${EVENT_ID}`)).json()) as Event;

  await page.goto(`/admin/events/${EVENT_ID}`);
  const typed = `My own text ${Date.now().toString(36)}`;
  await page.getByLabel("Title").fill(typed);
  await page.getByLabel("Description").fill("Description typed by the slower editor.");

  // meanwhile somebody else saves
  const other = `Saved first ${Date.now().toString(36)}`;
  expect((await admin.patch(`/api/events/${EVENT_ID}`, { data: { title: other, version: current.version } })).status()).toBe(200);

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("conflict")).toBeVisible();
  const saved = page.getByTestId("saved-version");
  await expect(saved).toContainText(other); // the saved version is shown ...
  await expect(page.getByLabel("Title")).toHaveValue(typed); // ... and what was typed is still there
  await expect(page.getByLabel("Description")).toHaveValue("Description typed by the slower editor.");

  // saving again is a deliberate overwrite and works
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("saved")).toBeVisible();
  expect(((await (await request.get(`/api/events/${EVENT_ID}`)).json()) as Event).title).toBe(typed);
  await admin.dispose();
});

test("access rules: anonymous -> 307 to the login page, an ordinary user -> 403, an administrator -> the form", async ({ request, browser, playwright }) => {
  const anonymous = await request.get(`/admin/events/${EVENT_ID}`, { maxRedirects: 0 });
  expect(anonymous.status()).toBe(307);
  expect(anonymous.headers()["location"]).toContain("/login?next=%2Fadmin%2Fevents%2F100");
  for (const path of ["/me/orders", "/checkout/00000000-0000-0000-0000-000000000000"]) {
    const reply = await request.get(path, { maxRedirects: 0 });
    expect(reply.status(), path).toBe(307);
  }

  const userContext = await browser.newContext();
  await loginInContext(userContext, ALICE);
  const forbidden = await userContext.request.get(`/admin/events/${EVENT_ID}`, { maxRedirects: 0 });
  expect(forbidden.status()).toBe(403);
  const page = await userContext.newPage();
  const response = await page.goto(`/admin/events/${EVENT_ID}`);
  expect(response?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
  await userContext.close();

  const admin = await adminRequest(playwright);
  expect((await admin.get(`/admin/events/${EVENT_ID}`)).status()).toBe(200);
  await admin.dispose();

  // and the api itself refuses a plain user
  const stranger = await browser.newContext();
  await registerInContext(stranger, newPerson("nobody"));
  expect((await stranger.request.patch(`/api/events/${EVENT_ID}`, { data: { title: "x", version: 1 } })).status()).toBe(403);
  await stranger.close();
});

test("the administrator finds the edit form from the event pages; nobody else sees the button, and it is never in the shared page cache", async ({ browser, request }) => {
  const EVENT = 3;
  // the pages everybody shares must not contain it (they come from a cache; whoever asks first would decide for everyone)
  for (const path of [`/events/${EVENT}`, `/events/${EVENT}/seats`]) {
    expect(await (await request.get(path)).text(), `${path} as served to anybody`).not.toContain("Edit event");
  }

  const adminContext = await browser.newContext();
  await loginInContext(adminContext, ADMIN);
  const adminPage = await adminContext.newPage();
  for (const path of [`/events/${EVENT}`, `/events/${EVENT}/seats`]) {
    await adminPage.goto(path);
    await expect(adminPage.getByTestId("edit-event"), path).toBeVisible();
  }
  await adminPage.getByTestId("edit-event").click();
  await expect(adminPage).toHaveURL(new RegExp(`/admin/events/${EVENT}$`));
  await expect(adminPage.getByLabel("Title")).toBeVisible();
  await adminContext.close();

  const userContext = await browser.newContext();
  await registerInContext(userContext, newPerson("not-admin"));
  const visitorContext = await browser.newContext();
  for (const [who, context] of [["an ordinary user", userContext], ["a visitor", visitorContext]] as const) {
    const page = await context.newPage();
    for (const path of [`/events/${EVENT}`, `/events/${EVENT}/seats`]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("link", { name: "Choose seats" }).or(page.getByTestId("selection-summary")), `${who} on ${path}`).toBeVisible();
      await expect(page.getByTestId("edit-event"), `${who} on ${path}`).toHaveCount(0);
    }
  }
  await userContext.close();
  await visitorContext.close();
});
