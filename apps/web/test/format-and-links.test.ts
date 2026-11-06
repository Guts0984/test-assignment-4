import { describe, expect, it } from "vitest";
import { filtersToQuery, readFilters } from "@/features/events/filters";
import { formatCountdown, formatDateTime } from "@/shared/lib/format";
import { queryKeys } from "@/shared/lib/query-keys";
import { safeNextPath } from "@/shared/lib/safe-next";

describe("dates (no hydration errors)", () => {
  it("are always written the same way, in UTC, whatever the machine's time zone or language", () => {
    expect(formatDateTime("2026-11-20T18:00:00.000Z")).toBe("Nov 20, 2026, 6:00 PM UTC");
    expect(formatDateTime("2026-12-31T23:59:00.000Z")).toBe("Dec 31, 2026, 11:59 PM UTC");
    expect(formatDateTime("2027-01-01T00:00:00.000Z")).toBe("Jan 1, 2027, 12:00 AM UTC");
  });

  it("the same text comes out under very different time-zone settings (what the server and a browser would see)", async () => {
    const original = process.env["TZ"];
    const texts = new Set<string>();
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env["TZ"] = tz;
      texts.add(formatDateTime("2026-11-20T23:30:00.000Z"));
    }
    if (original === undefined) delete process.env["TZ"];
    else process.env["TZ"] = original;
    expect([...texts]).toHaveLength(1);
    expect([...texts][0]).toMatch(/^Nov 20, 2026, 11:30\sPM UTC$/);
  });

  it("the countdown is mm:ss and never negative", () => {
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(61)).toBe("01:01");
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5)).toBe("00:00");
  });
});

describe("filters in the address", () => {
  it("are read from it, ignoring empty and blank values", () => {
    const params = new URLSearchParams("city=Chicago&q=%20jazz%20&from=&to=2026-12-01&unknown=1");
    expect(readFilters(params)).toEqual({ city: "Chicago", q: "jazz", to: "2026-12-01" });
  });

  it("are written back safely: special characters are encoded, empty ones left out, a cursor is added for the next page", () => {
    expect(filtersToQuery({})).toBe("");
    expect(filtersToQuery({ q: "a&b=c #1", city: "Los Angeles" })).toBe("?city=Los+Angeles&q=a%26b%3Dc+%231");
    expect(filtersToQuery({ q: "x" }, "abc_-")).toBe("?q=x&cursor=abc_-");
    expect(filtersToQuery({}, "cur")).toBe("?cursor=cur");
  });

  it("round trip: what is written can be read back", () => {
    const filters = { city: "Miami", q: "50% off & more", from: "2026-11-01", to: "2026-11-30" };
    expect(readFilters(new URLSearchParams(filtersToQuery(filters)))).toEqual(filters);
  });
});

describe("query keys", () => {
  it("different filters are different cache entries (so a slow old answer cannot land in the new one) and equal filters are the same", () => {
    expect(JSON.stringify(queryKeys.events({ q: "a" }))).not.toBe(JSON.stringify(queryKeys.events({ q: "ab" })));
    expect(JSON.stringify(queryKeys.events({ q: "a", city: "Chicago" }))).toBe(JSON.stringify(queryKeys.events({ q: "a", city: "Chicago" })));
  });
});

describe("where to go after logging in", () => {
  it.each(["/", "/events/5/seats", "/checkout/abc?x=1", "/me/orders"])("%s is allowed", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([null, undefined, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "evil", "/ok\nSet-Cookie: a=b", "/with\u0000nul", "\\\\host"])("%j becomes /", (path) => {
    expect(safeNextPath(path)).toBe("/");
  });
});
