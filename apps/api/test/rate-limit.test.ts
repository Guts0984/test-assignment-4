import { apiErrorSchema, ErrorCode } from "@app/shared";
import { signInternalRequest } from "@app/shared/internal";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { call, startApp, type Reply, type TestApp } from "./helpers";

const MAX = 50;
const asVisitor = (ip: string) => signInternalRequest(inject("internalSecret"), ip);
const limited = (replies: Reply[]) => replies.filter((reply) => reply.status === 429).length;

describe("the limit is shared by both instances (acceptance: 'common for both instances, by the end user's address')", () => {
  let a: TestApp;
  let b: TestApp;
  beforeAll(async () => {
    a = await startApp({ env: { RATE_LIMIT_MAX: String(MAX), RATE_LIMIT_WINDOW_SECONDS: "60" } });
    b = await startApp({ env: { RATE_LIMIT_MAX: String(MAX), RATE_LIMIT_WINDOW_SECONDS: "60" }, databaseUrl: a.databaseUrl, flush: false });
  });
  afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
  });

  it("40 requests to instance A and 40 to instance B at the same time: exactly 50 get through, 30 are refused", async () => {
    const visitor = asVisitor("203.0.113.1");
    const replies = await Promise.all([
      ...Array.from({ length: 40 }, () => call(a.base, "/me", { headers: visitor })),
      ...Array.from({ length: 40 }, () => call(b.base, "/me", { headers: visitor })),
    ]);
    expect(limited(replies)).toBe(30);
    expect(replies.length - limited(replies)).toBe(MAX);
  });

  it("the refusal is 429 RATE_LIMITED in the standard shape, with Retry-After", async () => {
    const reply = await call(a.base, "/me", { headers: asVisitor("203.0.113.1") });
    expect(reply.status).toBe(429);
    expect(apiErrorSchema.safeParse(reply.body).success).toBe(true);
    expect((reply.body as { code: string }).code).toBe(ErrorCode.RATE_LIMITED);
    expect(Number(reply.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("another visitor has a budget of their own", async () => {
    const reply = await call(b.base, "/me", { headers: asVisitor("203.0.113.2") });
    expect(reply.status).toBe(401);
    expect(reply.headers.get("x-ratelimit-limit")).toBe(String(MAX));
    expect(Number(reply.headers.get("x-ratelimit-remaining"))).toBe(MAX - 1);
  });

  it("health checks are never limited (Docker asks every few seconds)", async () => {
    const replies = await Promise.all(Array.from({ length: MAX + 20 }, () => call(a.base, "/health")));
    expect(limited(replies)).toBe(0);
  });

  it("guessing URLs is not free: unknown paths and broken requests count as well", async () => {
    const visitor = asVisitor("203.0.113.3");
    const replies = await Promise.all(Array.from({ length: MAX + 25 }, (_, i) => call(i % 2 ? a.base : b.base, `/nothing/${i}?x=%zz`, { headers: visitor })));
    expect(limited(replies)).toBe(25);
  });

  it("1000 different page URLs from one address: most are refused (acceptance check 11)", async () => {
    const visitor = asVisitor("203.0.113.4");
    const replies: Reply[] = [];
    for (let batch = 0; batch < 10; batch++) {
      replies.push(...(await Promise.all(Array.from({ length: 100 }, (_, i) => call(a.base, `/events/${batch * 100 + i + 1}`, { headers: visitor })))));
    }
    expect(replies.length).toBe(1000);
    expect(limited(replies)).toBe(1000 - MAX);
  });
});

describe("a made-up address does not help (acceptance check 12)", () => {
  it("behind the proxy, a browser-written X-Forwarded-For entry is ignored: the entry added by our proxy is the one used", async () => {
    const api = await startApp({ env: { RATE_LIMIT_MAX: String(MAX), RATE_LIMIT_WINDOW_SECONDS: "60", TRUST_PROXY: "loopback" } });
    try {
      // nginx adds the real address at the END; whatever the browser wrote stays in front of it.
      const replies = await Promise.all(Array.from({ length: MAX + 40 }, (_, i) => call(api.base, "/me", { headers: { "x-forwarded-for": `198.18.${i % 200}.${i}, 198.51.100.77` } })));
      expect(limited(replies)).toBe(40);
    } finally {
      await api.close();
    }
  });

  it("with no trusted proxy the header is ignored completely", async () => {
    const api = await startApp({ env: { RATE_LIMIT_MAX: String(MAX), RATE_LIMIT_WINDOW_SECONDS: "60", TRUST_PROXY: "none" } });
    try {
      const replies = await Promise.all(Array.from({ length: MAX + 40 }, (_, i) => call(api.base, "/me", { headers: { "x-forwarded-for": `198.18.0.${i + 1}`, "x-real-ip": `198.19.0.${i + 1}`, forwarded: `for=198.20.0.${i + 1}` } })));
      expect(limited(replies)).toBe(40);
    } finally {
      await api.close();
    }
  });

  it("a visitor address in X-End-User-IP is trusted only with a valid signature from our web server", async () => {
    const api = await startApp({ env: { RATE_LIMIT_MAX: String(MAX), RATE_LIMIT_WINDOW_SECONDS: "60", TRUST_PROXY: "none" } });
    try {
      const unsigned = await Promise.all(Array.from({ length: MAX + 10 }, (_, i) => call(api.base, "/me", { headers: { "x-end-user-ip": `198.18.1.${i + 1}` } })));
      expect(limited(unsigned)).toBe(10);

      // an old signature (replay) and a signature for another address are refused too
      const old = signInternalRequest(inject("internalSecret"), "198.18.2.1", Date.now() - 10 * 60 * 1000);
      const swapped = { ...asVisitor("198.18.2.2"), "x-end-user-ip": "198.18.2.3" };
      for (const headers of [old, swapped]) {
        const reply = await call(api.base, "/me", { headers });
        expect(reply.status).toBe(429); // still counted as the (already exhausted) real sender
      }
    } finally {
      await api.close();
    }
  });
});

describe("the window", () => {
  it("allows requests again when the window has passed", async () => {
    const api = await startApp({ env: { RATE_LIMIT_MAX: "3", RATE_LIMIT_WINDOW_SECONDS: "2" } });
    try {
      const visitor = asVisitor("203.0.113.9");
      const first = [];
      for (let i = 0; i < 5; i++) first.push(await call(api.base, "/me", { headers: visitor }));
      expect(limited(first)).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 2300));
      expect((await call(api.base, "/me", { headers: visitor })).status).toBe(401);
    } finally {
      await api.close();
    }
  });
});
