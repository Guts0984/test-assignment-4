import { expect, test } from "@playwright/test";

// Requests that nginx refuses by itself (the api never sees them) must still come back in the api's error shape.
async function expectJsonError(reply: { status(): number; headers(): Record<string, string>; text(): Promise<string> }, status: number, label: string) {
  expect(reply.status(), label).toBe(status);
  expect(reply.headers()["content-type"], label).toContain("application/json");
  const body = JSON.parse(await reply.text()) as { code?: unknown; message?: unknown };
  expect(typeof body.code, label).toBe("string");
  expect(typeof body.message, label).toBe("string");
}

test("a request that is too large is a 413 in the common error shape", async ({ request }) => {
  const reply = await request.post("/api/auth/login", { data: { email: "a@example.com", password: "x".repeat(3_000_000) } });
  await expectJsonError(reply, 413, "3 MB body");
});

// nginx refuses these before it has parsed the request, so it can only use its own plain page: the status must still be a 4xx.
test("an address or headers that are too long are a 4xx, never a 5xx", async ({ request }) => {
  const long = await request.get(`/api/events?q=${"a".repeat(20_000)}`);
  expect(long.status(), "20 kB address").toBe(414);
  const heavy = await request.get("/api/events", { headers: { "x-junk": "j".repeat(40_000) } });
  expect([400, 431], "40 kB header").toContain(heavy.status());
});

// nginx refuses a "%00" in the address before it has parsed the request: its own plain page, but still a 4xx.
test("a NUL byte in the address is a 4xx, never a 5xx", async ({ request }) => {
  for (const path of ["/api/events/%00", "/api/holds/%00", "/events/%00"]) {
    const reply = await request.delete(path);
    expect(reply.status(), path).toBeGreaterThanOrEqual(400);
    expect(reply.status(), path).toBeLessThan(500);
  }
});
