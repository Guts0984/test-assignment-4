import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, startApp, type TestApp } from "./helpers";

let api: TestApp;
beforeAll(async () => {
  api = await startApp();
});
afterAll(async () => {
  await api.close();
});

describe("health checks", () => {
  it("/health says the process is alive", async () => {
    const reply = await call(api.base, "/health");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ status: "ok" });
  });

  it("/ready says PostgreSQL and Redis are both reachable", async () => {
    const reply = await call(api.base, "/ready");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ status: "ready", postgres: "up", redis: "up" });
  });
});

describe("request id", () => {
  it("a good id from nginx is kept and sent back", async () => {
    const reply = await call(api.base, "/health", { headers: { "x-request-id": "abc12345-good" } });
    expect(reply.headers.get("x-request-id")).toBe("abc12345-good");
  });

  it("a missing or dangerous id is replaced by a new one (it ends up in logs and headers)", async () => {
    for (const bad of [undefined, "short", "has spaces and ../ and <script>", "x".repeat(200)]) {
      const reply = await call(api.base, "/health", bad === undefined ? {} : { headers: { "x-request-id": bad } });
      const id = reply.headers.get("x-request-id") ?? "";
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("API documentation", () => {
  it("Swagger UI is served at /docs", async () => {
    const reply = await call(api.base, "/docs");
    expect(reply.status).toBe(200);
    expect(reply.text.toLowerCase()).toContain("swagger");
  });

  it("the OpenAPI document lists the endpoints and describes the login body from the same schema that validates it", async () => {
    const reply = await call(api.base, "/openapi.json");
    expect(reply.status).toBe(200);
    const doc = reply.body as { paths: Record<string, Record<string, { requestBody?: { content: { "application/json": { schema: { properties?: Record<string, unknown>; required?: string[] } } } } }>> };
    for (const path of ["/health", "/ready", "/auth/register", "/auth/login", "/auth/logout", "/me"]) {
      expect(Object.keys(doc.paths)).toContain(path);
    }
    const loginSchema = doc.paths["/auth/login"]?.["post"]?.requestBody?.content["application/json"].schema;
    expect(Object.keys(loginSchema?.properties ?? {}).sort()).toEqual(["email", "password"]);
    expect(loginSchema?.required?.sort()).toEqual(["email", "password"]);
  });
});
