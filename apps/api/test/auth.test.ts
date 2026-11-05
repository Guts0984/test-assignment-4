import { ErrorCode } from "@app/shared";
import { signInternalRequest } from "@app/shared/internal";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { call, login, startApp, type TestApp } from "./helpers";

let api: TestApp;
let redis: Redis;
const passwords = inject("seedPasswords");
const ALICE = "alice@example.com";

beforeAll(async () => {
  api = await startApp();
  redis = new Redis(inject("redisUrl"));
});
afterAll(async () => {
  redis.disconnect();
  await api.close();
});

/** A visitor address the api will believe: only our own web server can sign it. */
const asVisitor = (ip: string) => signInternalRequest(inject("internalSecret"), ip);

describe("register", () => {
  it("creates the account, logs in at once, and the cookie works", async () => {
    const reply = await call(api.base, "/auth/register", { body: { email: "New.Person@Example.com", password: "a good password" } });
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ user: { email: "new.person@example.com", role: "user" } });
    const cookie = (reply.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const me = await call(api.base, "/me", { cookie });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user: { email: "new.person@example.com" } });
  });

  it("never returns or stores the password; the stored value is a salted hash", async () => {
    await call(api.base, "/auth/register", { body: { email: "hash.check@example.com", password: "plain text secret 1" } });
    const row = await api.infra.db.user.findUniqueOrThrow({ where: { email: "hash.check@example.com" } });
    expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(row.passwordHash).not.toContain("plain text secret 1");
  });

  it("the same email twice is 409 EMAIL_TAKEN, whatever the letter case", async () => {
    const first = await call(api.base, "/auth/register", { body: { email: "twice@example.com", password: "password one 1" } });
    expect(first.status).toBe(201);
    const second = await call(api.base, "/auth/register", { body: { email: "TWICE@EXAMPLE.COM", password: "password two 2" } });
    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe(ErrorCode.EMAIL_TAKEN);
  });

  it("20 registrations of the same email at the same moment: exactly one account", async () => {
    const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => call(api.base, "/auth/register", { body: { email: "race@example.com", password: `password number ${i} x` }, headers: asVisitor(`10.1.0.${i + 1}`) })));
    expect(replies.filter((reply) => reply.status === 201)).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 409)).toHaveLength(19);
    expect(await api.infra.db.user.count({ where: { email: "race@example.com" } })).toBe(1);
  });

  it("refuses weak or silly passwords and emails with 400", async () => {
    for (const body of [
      { email: "a@example.com", password: "short" },
      { email: "a@example.com", password: "        " },
      { email: "a@example.com", password: "x".repeat(129) },
      { email: "no-at-sign", password: "long enough pass" },
      { email: "", password: "long enough pass" },
    ]) {
      expect((await call(api.base, "/auth/register", { body })).status).toBe(400);
    }
  });
});

describe("login, session and logout", () => {
  it("a seeded user logs in and /me shows who they are; the admin has the admin role", async () => {
    const alice = await login(api.base, ALICE, passwords.user);
    expect(alice.reply.status).toBe(200);
    expect(alice.reply.body).toMatchObject({ user: { email: ALICE, role: "user" } });
    const admin = await login(api.base, "admin@example.com", passwords.admin);
    expect(admin.reply.body).toMatchObject({ user: { role: "admin" } });
    expect((await call(api.base, "/me", { cookie: admin.cookie })).body).toMatchObject({ user: { email: "admin@example.com", role: "admin" } });
  });

  it("the email is not case sensitive, the password is", async () => {
    expect((await login(api.base, "ALICE@Example.COM", passwords.user)).reply.status).toBe(200);
    expect((await login(api.base, ALICE, passwords.user.toUpperCase())).reply.status).toBe(401);
  });

  it("the cookie is httpOnly, SameSite=Lax, path /, with an expiry, and NOT Secure by default", async () => {
    const { reply } = await login(api.base, ALICE, passwords.user);
    const cookie = (reply.headers.get("set-cookie") ?? "").toLowerCase();
    expect(cookie).toContain("sid=");
    expect(cookie).toContain("httponly");
    expect(cookie).toContain("samesite=lax");
    expect(cookie).toContain("path=/");
    expect(cookie).toMatch(/max-age=\d+/);
    expect(cookie).not.toContain("secure");
  });

  it("the Secure flag is switched on by the environment variable", async () => {
    const secure = await startApp({ env: { COOKIE_SECURE: "true" }, flush: false });
    try {
      const { reply } = await login(secure.base, ALICE, passwords.user);
      expect((reply.headers.get("set-cookie") ?? "").toLowerCase()).toContain("secure");
    } finally {
      await secure.close();
    }
  });

  it("the session is in Redis (shared by every instance), under a hash of the cookie, with an expiry", async () => {
    const { cookie } = await login(api.base, ALICE, passwords.user);
    const sessionId = cookie.replace("sid=", "");
    const keys = await redis.keys("sess:*");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((key) => key.includes(sessionId))).toBe(false); // the raw cookie value is not the key
    const ttl = await redis.ttl(keys[0] ?? "");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(api.env.SESSION_TTL_SECONDS);
  });

  it("a session made on one instance works on the other", async () => {
    const second = await startApp({ databaseUrl: api.databaseUrl, flush: false });
    try {
      const { cookie } = await login(api.base, ALICE, passwords.user);
      const me = await call(second.base, "/me", { cookie });
      expect(me.status).toBe(200);
    } finally {
      await second.close();
    }
  });

  it("logout ends the session for good: the old cookie no longer works", async () => {
    const { cookie } = await login(api.base, ALICE, passwords.user);
    expect((await call(api.base, "/me", { cookie })).status).toBe(200);
    const out = await call(api.base, "/auth/logout", { method: "POST", cookie });
    expect(out.status).toBe(204);
    expect((out.headers.get("set-cookie") ?? "").toLowerCase()).toMatch(/sid=;|expires=thu, 01 jan 1970/);
    expect((await call(api.base, "/me", { cookie })).status).toBe(401);
  });

  it("logout without being logged in is fine (204)", async () => {
    expect((await call(api.base, "/auth/logout", { method: "POST" })).status).toBe(204);
  });

  it("a session expires by itself when its time is up", async () => {
    const { cookie } = await login(api.base, ALICE, passwords.user);
    const key = (await redis.keys("sess:*"))[0] as string;
    for (const k of await redis.keys("sess:*")) await redis.expire(k, 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(key).toBeDefined();
    expect((await call(api.base, "/me", { cookie })).status).toBe(401);
  });

  it("using the session pushes its expiry forward (sliding)", async () => {
    const { cookie } = await login(api.base, ALICE, passwords.user);
    const key = (await redis.keys("sess:*"))[0] as string;
    await redis.expire(key, 30);
    await call(api.base, "/me", { cookie });
    expect(await redis.ttl(key)).toBeGreaterThan(1000);
  });

  it("garbage, forged and missing cookies are 401, never 500", async () => {
    for (const cookie of ["sid=", "sid=abc", `sid=${"A".repeat(43)}`, `sid=${"A".repeat(5000)}`, "sid=%00%00", "other=1", "sid=a; sid=b", "sid"]) {
      const reply = await call(api.base, "/me", { cookie });
      expect(reply.status, cookie).toBe(401);
      expect((reply.body as { code: string }).code).toBe(ErrorCode.UNAUTHENTICATED);
    }
    expect((await call(api.base, "/me")).status).toBe(401);
  });

  it("two logins give two independent sessions; logging one out leaves the other", async () => {
    const a = await login(api.base, ALICE, passwords.user);
    const b = await login(api.base, ALICE, passwords.user);
    expect(a.cookie).not.toBe(b.cookie);
    await call(api.base, "/auth/logout", { method: "POST", cookie: a.cookie });
    expect((await call(api.base, "/me", { cookie: a.cookie })).status).toBe(401);
    expect((await call(api.base, "/me", { cookie: b.cookie })).status).toBe(200);
  });
});

describe("wrong passwords", () => {
  it("an unknown email and a wrong password give the same answer (an outsider cannot learn which emails exist)", async () => {
    const unknown = await call(api.base, "/auth/login", { body: { email: "nobody-here@example.com", password: "whatever123" } });
    const wrong = await call(api.base, "/auth/login", { body: { email: ALICE, password: "whatever123" } });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("an unknown email takes about as long as a wrong password (a decoy hash is checked)", async () => {
    const time = async (email: string): Promise<number> => {
      const started = performance.now();
      await call(api.base, "/auth/login", { body: { email, password: "whatever123" }, headers: asVisitor(`10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) });
      return performance.now() - started;
    };
    const samples = async (email: string) => Promise.all([0, 1, 2, 3, 4].map(() => time(email))).then((values) => values.sort((a, b) => a - b)[2] ?? 0);
    const known = await samples(ALICE);
    const unknown = await samples("ghost@example.com");
    // Without the decoy the unknown email would answer in ~2 ms and the known one in ~100 ms.
    expect(unknown).toBeGreaterThan(known * 0.4);
  });
});

describe("guessing protection that cannot lock the owner out (acceptance check 13)", () => {
  it("10 wrong passwords for someone else's account from one address: the owner can still log in, even from that same address", async () => {
    const attacker = asVisitor("203.0.113.50");
    for (let i = 0; i < 10; i++) {
      expect((await call(api.base, "/auth/login", { body: { email: ALICE, password: `guess number ${i}` }, headers: attacker })).status).toBe(401);
    }
    const sameAddress = await login(api.base, ALICE, passwords.user, attacker);
    expect(sameAddress.reply.status).toBe(200);
    const otherAddress = await login(api.base, ALICE, passwords.user, asVisitor("198.51.100.7"));
    expect(otherAddress.reply.status).toBe(200);
  });

  it("an address that keeps guessing is stopped (429 with Retry-After), but only that address", async () => {
    const attacker = asVisitor("203.0.113.60");
    const limit = api.env.LOGIN_FAILURES_MAX;
    for (let i = 0; i < limit; i++) {
      expect((await call(api.base, "/auth/login", { body: { email: ALICE, password: `guess ${i}` }, headers: attacker })).status).toBe(401);
    }
    const stopped = await call(api.base, "/auth/login", { body: { email: ALICE, password: passwords.user }, headers: attacker });
    expect(stopped.status).toBe(429);
    expect(stopped.headers.get("retry-after")).toMatch(/^\d+$/);
    // the real owner, somewhere else, is not affected
    expect((await login(api.base, ALICE, passwords.user, asVisitor("198.51.100.8"))).reply.status).toBe(200);
    // and so is every other account
    expect((await login(api.base, "bob@example.com", passwords.user, asVisitor("198.51.100.9"))).reply.status).toBe(200);
  });

  it("guesses at 40 different accounts from one address count together", async () => {
    const attacker = asVisitor("203.0.113.70");
    const results: number[] = [];
    for (let i = 0; i < api.env.LOGIN_FAILURES_MAX + 3; i++) {
      results.push((await call(api.base, "/auth/login", { body: { email: `victim${i}@example.com`, password: "guess guess 1" }, headers: attacker })).status);
    }
    expect(results.slice(-3)).toEqual([429, 429, 429]);
  });

  it("successful logins do not count and do not wash the count away", async () => {
    const attacker = asVisitor("203.0.113.80");
    for (let i = 0; i < 6; i++) await call(api.base, "/auth/login", { body: { email: ALICE, password: `bad ${i}` }, headers: attacker });
    // the attacker logs into an account of their own between guesses: this must not reset the counter
    for (let i = 0; i < 6; i++) {
      await login(api.base, "bob@example.com", passwords.user, attacker);
      await call(api.base, "/auth/login", { body: { email: ALICE, password: `bad again ${i}` }, headers: attacker });
    }
    const failures = await redis.get("rl:login-failures:203.0.113.80");
    expect(Number(failures)).toBe(12);
  });

  it("30 parallel guesses cannot all slip through before the counter notices", async () => {
    const attacker = asVisitor("203.0.113.90");
    const replies = await Promise.all(Array.from({ length: 80 }, (_, i) => call(api.base, "/auth/login", { body: { email: ALICE, password: `parallel ${i}` }, headers: attacker })));
    const evaluated = replies.filter((reply) => reply.status === 401).length;
    expect(replies.some((reply) => reply.status === 429)).toBe(true);
    expect(evaluated).toBeLessThan(80);
    expect(replies.every((reply) => reply.status === 401 || reply.status === 429)).toBe(true);
  });
});

describe("a made-up visitor address does not work", () => {
  it("an unsigned or wrongly signed X-End-User-IP is ignored: the real sender is counted", async () => {
    // 40 wrong passwords, each claiming to come from a different address, but none of the claims is signed.
    const replies = [];
    for (let i = 0; i < api.env.LOGIN_FAILURES_MAX + 2; i++) {
      replies.push(await call(api.base, "/auth/login", { body: { email: "victim@example.com", password: "guess guess 1" }, headers: { "x-end-user-ip": `192.0.2.${i + 1}` } }));
    }
    expect(replies.at(-1)?.status).toBe(429);

    const wrongSecret = signInternalRequest("not the real secret, but long enough to look real", "192.0.2.200");
    const forged = await call(api.base, "/auth/login", { body: { email: "victim@example.com", password: "guess guess 1" }, headers: wrongSecret });
    expect(forged.status).toBe(429); // still counted as the same real sender
  });
});
