import { apiErrorSchema, ErrorCode } from "@app/shared";
import { HttpException, NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import { AppError, isDependencyFailure, renderError } from "../src/http/errors";
import { call, startApp, type Reply, type TestApp } from "./helpers";

let api: TestApp;
beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
});

/** The assignment: "any wrong input is 4xx, never 5xx" and one error format. */
function expectClientError(reply: Reply, status?: number): void {
  expect(reply.status, `status for body ${reply.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
  expect(reply.status).toBeLessThan(500);
  if (status) expect(reply.status).toBe(status);
  const parsed = apiErrorSchema.safeParse(reply.body);
  expect(parsed.success, `error format for ${reply.text.slice(0, 200)}`).toBe(true);
}

describe("one error format", () => {
  it("an unknown address is 404 NOT_FOUND in the standard shape", async () => {
    const reply = await call(api.base, "/no/such/thing");
    expectClientError(reply, 404);
    expect((reply.body as { code: string }).code).toBe(ErrorCode.NOT_FOUND);
  });

  it("an unknown method on a known address is also a clean 4xx", async () => {
    expectClientError(await call(api.base, "/health", { method: "DELETE" }));
  });

  it("validation errors say which field is wrong, in words a person can read", async () => {
    const reply = await call(api.base, "/auth/register", { body: { email: "not-an-email", password: "short" } });
    expectClientError(reply, 400);
    const fields = (reply.body as { details: { fields: Record<string, string[]> } }).details.fields;
    expect(fields["email"]?.[0]).toMatch(/valid email/i);
    expect(fields["password"]?.[0]).toMatch(/at least 8/i);
  });

  it("an unknown field is refused, not silently ignored", async () => {
    const reply = await call(api.base, "/auth/login", { body: { email: "a@b.co", password: "x", role: "admin" } });
    expectClientError(reply, 400);
  });
});

describe("hostile input is always 4xx, never 5xx", () => {
  const json = (rawBody: string, extra: Record<string, string> = {}) => ({ rawBody, headers: { "content-type": "application/json", ...extra } });

  const cases: Array<[string, () => Promise<Reply>]> = [
    ["malformed JSON", () => call(api.base, "/auth/login", json("{not json"))],
    ["truncated JSON", () => call(api.base, "/auth/login", json('{"email":"a@b.co","password":"x"'))],
    ["empty body", () => call(api.base, "/auth/login", json(""))],
    ["JSON null", () => call(api.base, "/auth/login", json("null"))],
    ["JSON array instead of object", () => call(api.base, "/auth/login", json("[1,2,3]"))],
    ["JSON string instead of object", () => call(api.base, "/auth/login", json('"hello"'))],
    ["wrong content type", () => call(api.base, "/auth/login", { rawBody: "email=a&password=b", headers: { "content-type": "application/x-www-form-urlencoded" } })],
    ["plain text content type", () => call(api.base, "/auth/login", { rawBody: "hello", headers: { "content-type": "text/plain" } })],
    ["unsupported charset", () => call(api.base, "/auth/login", json("{}", { "content-type": "application/json; charset=utf-7" }))],
    ["numbers instead of strings", () => call(api.base, "/auth/login", { body: { email: 123, password: 456 } })],
    ["huge numbers", () => call(api.base, "/auth/login", json('{"email":1e999,"password":-1e999}'))],
    ["arrays instead of strings", () => call(api.base, "/auth/login", { body: { email: ["a"], password: [["b"]] } })],
    ["nested objects", () => call(api.base, "/auth/login", { body: { email: { $ne: null }, password: { $gt: "" } } })],
    ["NUL byte in the email", () => call(api.base, "/auth/login", { body: { email: "a\u0000b@example.com", password: "x" } })],
    ["NUL byte in the password", () => call(api.base, "/auth/login", { body: { email: "a@example.com", password: "pa\u0000ss" } })],
    ["NUL byte in a field name", () => call(api.base, "/auth/login", json('{"em\\u0000ail":"a@b.co","password":"x"}'))],
    ["NUL byte, registering", () => call(api.base, "/auth/register", { body: { email: "x@example.com", password: "long enough \u0000 password" } })],
    ["NUL byte in the path", () => call(api.base, "/events/1%00")],
    ["NUL byte in the query", () => call(api.base, "/events?q=%00&city=%00")],
    ["NUL byte in the query, other case", () => call(api.base, "/events?q=a%00b")],
    ["broken percent-encoding", () => call(api.base, "/events/%E0%A4%A")],
    ["a lone % in the path", () => call(api.base, "/me%")],
    ["very long email", () => call(api.base, "/auth/login", { body: { email: `${"a".repeat(10_000)}@example.com`, password: "x" } })],
    ["very long password", () => call(api.base, "/auth/login", { body: { email: "a@example.com", password: "p".repeat(5000) } })],
    ["lone surrogate in the email", () => call(api.base, "/auth/login", json('{"email":"\\ud800@example.com","password":"x"}'))],
    ["emoji and right-to-left text", () => call(api.base, "/auth/login", { body: { email: "‮@example.com", password: "🔥".repeat(10) } })],
    ["SQL in the email", () => call(api.base, "/auth/login", { body: { email: "' OR 1=1 --@example.com", password: "x" } })],
    ["deeply nested JSON", () => call(api.base, "/auth/login", json(`${'{"a":'.repeat(500)}1${"}".repeat(500)}`))],
    ["duplicate keys", () => call(api.base, "/auth/login", json('{"email":"a@example.com","email":"b@example.com","password":"x"}'))],
  ];

  it.each(cases)("%s", async (_name, run) => {
    const reply = await run();
    // A wrong password is also a clean 4xx; the point is that nothing here may crash or answer 5xx.
    expectClientError(reply);
  });

  it("a body bigger than the limit is 413 PAYLOAD_TOO_LARGE", async () => {
    const reply = await call(api.base, "/auth/login", json(JSON.stringify({ email: "a@example.com", password: "x", filler: "z".repeat(300_000) })));
    expectClientError(reply, 413);
    expect((reply.body as { code: string }).code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it("an enormous address is refused by the server before our code (4xx, no crash)", async () => {
    const reply = await call(api.base, `/${"a".repeat(70_000)}`);
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.status).toBeLessThan(500);
  });

  it("after all that abuse the api is still healthy", async () => {
    expect((await call(api.base, "/ready")).status).toBe(200);
  });
});

describe("renderError: whatever is thrown, the answer is a sane response", () => {
  it("a deliberate AppError keeps its status, code, details and headers", () => {
    const rendered = renderError(new AppError(409, ErrorCode.VERSION_CONFLICT, "Changed meanwhile.", { current: 3 }, { "X-A": "1" }));
    expect(rendered).toEqual({ status: 409, body: { code: "VERSION_CONFLICT", message: "Changed meanwhile.", details: { current: 3 } }, headers: { "X-A": "1" } });
  });

  it("a Zod error becomes a 400 with fields", () => {
    const failure = z.object({ n: z.number() }).safeParse({ n: "x" });
    const rendered = renderError(failure.error instanceof ZodError ? failure.error : new Error("no failure"));
    expect(rendered.status).toBe(400);
    expect(rendered.body.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("framework exceptions keep their 4xx status", () => {
    expect(renderError(new NotFoundException()).status).toBe(404);
    expect(renderError(new HttpException("nope", 403)).body.code).toBe(ErrorCode.FORBIDDEN);
  });

  it("a failing database or Redis is 503 with Retry-After, never a 500 and never a stack trace", () => {
    const failures = [
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
      new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      new Error("Command timed out"),
      new Error("Connection is closed."),
      Object.assign(new Error("Can't reach database server"), { code: "P1001" }),
      Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }),
      new Error("timeout exceeded when trying to connect"),
      new Error("Invalid `db.user.findUnique()` invocation\nDatabase error. Code: `57P03`. Message: `the database system is not yet accepting connections`"),
      new Error("Database error. Code: `57P01`. Message: `terminating connection due to administrator command`"),
      new Error("the database system is starting up"),
      new Error("Server has closed the connection."),
      new Error("Unable to start a transaction in the given time."),
      Object.assign(new Error("Transaction API error"), { code: "P2028" }),
      new Error("Connection terminated unexpectedly"),
    ];
    for (const failure of failures) {
      expect(isDependencyFailure(failure), failure.message).toBe(true);
      const rendered = renderError(failure);
      expect(rendered.status).toBe(503);
      expect(rendered.headers?.["Retry-After"]).toBeDefined();
      expect(JSON.stringify(rendered.body)).not.toContain("ECONNREFUSED");
    }
  });

  it("an unexpected bug is a 500 that tells the client nothing about the inside", () => {
    const rendered = renderError(new Error("secret table name users_private leaked here"));
    expect(rendered.status).toBe(500);
    expect(JSON.stringify(rendered.body)).not.toContain("secret");
  });

  it("body-reader style errors keep their 4xx status", () => {
    expect(renderError(Object.assign(new Error("x"), { status: 400 })).status).toBe(400);
    expect(renderError(Object.assign(new Error("x"), { statusCode: 413 })).body.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it("thrown non-errors do not crash the renderer", () => {
    for (const odd of [null, undefined, "text", 42, {}, []]) {
      expect(() => renderError(odd)).not.toThrow();
      expect(renderError(odd).status).toBe(500);
    }
  });
});
