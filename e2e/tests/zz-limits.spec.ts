import { expect, test } from "@playwright/test";
import { ALICE, newPerson } from "./helpers";

// These tests use up the rate limits of the visitor address they run from, so they come last (zz-) and wait for the limits to recover.
test.describe.configure({ mode: "serial" });

async function waitUntilCalm(request: import("@playwright/test").APIRequestContext) {
  await expect
    .poll(async () => (await request.get("/api/events/1")).status(), { timeout: 30_000, intervals: [1000], message: "the limits recover" })
    .toBe(200);
  await expect.poll(async () => (await request.get("/events/1")).status(), { timeout: 30_000, intervals: [1000] }).toBe(200);
}

test("a made-up X-Forwarded-For does not get around the limit (acceptance check 12)", async ({ request }) => {
  const statuses: number[] = [];
  for (let batch = 0; batch < 8; batch++) {
    const replies = await Promise.all(Array.from({ length: 60 }, (_, i) => request.get("/api/events/1", { headers: { "x-forwarded-for": `203.0.${batch}.${i + 1}`, "x-real-ip": `198.51.${batch}.${i + 1}`, "x-end-user-ip": `192.0.2.${i + 1}` } })));
    statuses.push(...replies.map((r) => r.status()));
  }
  expect(statuses.filter((s) => s === 429).length, "requests that claimed other addresses are still limited").toBeGreaterThan(100);
  expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
  await waitUntilCalm(request);
});

test("a NUL byte is a clean 4xx, never a 5xx, wherever it is put", async ({ request }) => {
  for (const path of ["/api/events?q=%00", "/api/events?city=a%00b", "/api/events/%00", "/api/events/1%00", "/events/%00", "/events?q=%00", "/%00"]) {
    const reply = await request.get(path);
    expect(reply.status(), path).toBeGreaterThanOrEqual(400);
    expect(reply.status(), path).toBeLessThan(500);
  }
  const login = await request.post("/api/auth/login", { data: { email: "a@example.com", password: "pa\u0000ss" } });
  expect(login.status()).toBeLessThan(500);
  const search = await request.get("/api/events?q=%25%5C_");
  expect(search.status()).toBe(200);
  expect((await search.json()).items).toEqual([]); // % \ _ are only characters, not wildcards
});

test("guessing 1000 different page addresses from one address is stopped by a limit (acceptance check 11)", async ({ request }) => {
  const statuses: number[] = [];
  for (let batch = 0; batch < 20; batch++) {
    const replies = await Promise.all(Array.from({ length: 50 }, (_, i) => request.get(`/events/${100_000 + batch * 50 + i}`)));
    statuses.push(...replies.map((r) => r.status()));
  }
  expect(statuses).toHaveLength(1000);
  const limited = statuses.filter((s) => s === 429).length;
  expect(limited, "most guesses are refused").toBeGreaterThan(500);
  expect(statuses.every((s) => s === 404 || s === 429)).toBe(true);
  await waitUntilCalm(request);
});

test("10 wrong passwords for someone else's account do not lock the owner out (acceptance check 13)", async ({ request }) => {
  await waitUntilCalm(request);
  for (let i = 0; i < 10; i++) {
    const reply = await request.post("/api/auth/login", { data: { email: ALICE.email, password: `wrong-guess-${i}` } });
    expect(reply.status()).toBe(401);
  }
  const owner = await request.post("/api/auth/login", { data: ALICE });
  expect(owner.status(), "the owner can still log in").toBe(200);
  // a brand-new account is unaffected as well
  const fresh = newPerson("after-guessing");
  expect((await request.post("/api/auth/register", { data: fresh })).status()).toBe(201);
  await request.post("/api/auth/logout");
});
