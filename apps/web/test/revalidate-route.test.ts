import { signInternalRequest } from "@app/shared/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidated: Array<[string, unknown]> = [];
vi.mock("next/cache", () => ({ revalidateTag: (tag: string, profile: unknown) => revalidated.push([tag, profile]) }));

const SECRET = "x".repeat(40);
process.env["INTERNAL_SECRET"] = SECRET;

const { POST } = await import("@/app/internal/revalidate/route");

const call = (headers: Record<string, string>, body: unknown) =>
  POST(new Request("http://web/internal/revalidate", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));

beforeEach(() => {
  revalidated.length = 0;
});

describe("POST /internal/revalidate (called by the worker)", () => {
  it("a correctly signed call makes the cache forget the tags at once", async () => {
    const response = await call(signInternalRequest(SECRET), { tags: ["event:7", "events"] });
    expect(response.status).toBe(200);
    expect(revalidated).toEqual([["event:7", { expire: 0 }], ["events", { expire: 0 }]]);
  });

  it.each([
    ["no signature", {}],
    ["a signature made with another secret", signInternalRequest("y".repeat(40))],
    ["a signature that is too old (a copy of an earlier call)", signInternalRequest(SECRET, undefined, Date.now() - 10 * 60 * 1000)],
    ["a garbage signature", { "x-internal-timestamp": String(Date.now()), "x-internal-signature": "zz" }],
  ])("refuses %s with 401 and forgets nothing", async (_name, headers) => {
    const response = await call(headers, { tags: ["events"] });
    expect(response.status).toBe(401);
    expect(revalidated).toEqual([]);
  });

  it.each([["not json", "{nope"], ["no tags", {}], ["empty list", { tags: [] }], ["a tag that is not text", { tags: [5] }], ["too many tags", { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }], ["an empty tag", { tags: [""] }]])(
    "a signed call with %s is a 400",
    async (_name, body) => {
      const response = await call(signInternalRequest(SECRET), body);
      expect(response.status).toBe(400);
      expect(revalidated).toEqual([]);
    },
  );
});
