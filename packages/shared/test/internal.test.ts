import { describe, expect, it } from "vitest";
import {
  INTERNAL_IP_HEADER,
  INTERNAL_MAX_AGE_MS,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
  verifyInternalRequest,
} from "../src/internal";

const secret = "s".repeat(40);
const now = 1_800_000_000_000;

describe("signed calls between our own programs", () => {
  it("a call signed for a visitor is accepted and speaks for that visitor", () => {
    const headers = signInternalRequest(secret, "203.0.113.7", now);
    expect(verifyInternalRequest(secret, headers, now)).toEqual({ trusted: true, ip: "203.0.113.7" });
  });

  it("a call signed with no visitor is accepted as 'ours' with no address", () => {
    const headers = signInternalRequest(secret, undefined, now);
    expect(headers[INTERNAL_IP_HEADER]).toBeUndefined();
    expect(verifyInternalRequest(secret, headers, now)).toEqual({ trusted: true, ip: undefined });
  });

  it("is refused when signed with another secret", () => {
    const headers = signInternalRequest("another-secret-another-secret-12345", "1.1.1.1", now);
    expect(verifyInternalRequest(secret, headers, now)).toEqual({ trusted: false });
  });

  it("is refused when the address is changed after signing", () => {
    const headers = signInternalRequest(secret, "1.1.1.1", now);
    expect(verifyInternalRequest(secret, { ...headers, [INTERNAL_IP_HEADER]: "2.2.2.2" }, now).trusted).toBe(false);
  });

  it("an address cannot be added to a call that was signed without one, or removed from one that had it", () => {
    const withoutIp = signInternalRequest(secret, undefined, now);
    expect(verifyInternalRequest(secret, { ...withoutIp, [INTERNAL_IP_HEADER]: "9.9.9.9" }, now).trusted).toBe(false);
    const withIp = signInternalRequest(secret, "9.9.9.9", now);
    const stripped = Object.fromEntries(Object.entries(withIp).filter(([name]) => name !== INTERNAL_IP_HEADER));
    expect(verifyInternalRequest(secret, stripped, now).trusted).toBe(false);
  });

  it("is refused when the timestamp was changed", () => {
    const headers = signInternalRequest(secret, "1.1.1.1", now);
    expect(verifyInternalRequest(secret, { ...headers, [INTERNAL_TIMESTAMP_HEADER]: String(now + 1) }, now).trusted).toBe(false);
  });

  it("is refused when too old or too far in the future, accepted just inside the limit", () => {
    const headers = signInternalRequest(secret, "1.1.1.1", now);
    expect(verifyInternalRequest(secret, headers, now + INTERNAL_MAX_AGE_MS).trusted).toBe(true);
    expect(verifyInternalRequest(secret, headers, now + INTERNAL_MAX_AGE_MS + 1).trusted).toBe(false);
    expect(verifyInternalRequest(secret, headers, now - INTERNAL_MAX_AGE_MS).trusted).toBe(true);
    expect(verifyInternalRequest(secret, headers, now - INTERNAL_MAX_AGE_MS - 1).trusted).toBe(false);
  });

  it.each([
    ["no headers at all", {}],
    ["only an address", { [INTERNAL_IP_HEADER]: "1.1.1.1" }],
    ["a signature but no timestamp", { [INTERNAL_SIGNATURE_HEADER]: "ab".repeat(32) }],
    ["a timestamp but no signature", { [INTERNAL_TIMESTAMP_HEADER]: String(now) }],
    ["a signature that is not hex", { [INTERNAL_TIMESTAMP_HEADER]: String(now), [INTERNAL_SIGNATURE_HEADER]: "zz".repeat(32) }],
    ["a signature of the wrong length", { [INTERNAL_TIMESTAMP_HEADER]: String(now), [INTERNAL_SIGNATURE_HEADER]: "ab" }],
    ["an empty signature", { [INTERNAL_TIMESTAMP_HEADER]: String(now), [INTERNAL_SIGNATURE_HEADER]: "" }],
    ["a timestamp that is not a number", { [INTERNAL_TIMESTAMP_HEADER]: "now", [INTERNAL_SIGNATURE_HEADER]: "ab".repeat(32) }],
    ["headers sent twice", { [INTERNAL_TIMESTAMP_HEADER]: [String(now), String(now)], [INTERNAL_SIGNATURE_HEADER]: ["ab", "cd"] }],
  ])("is refused, without crashing, for %s", (_name, headers) => {
    expect(verifyInternalRequest(secret, headers, now)).toEqual({ trusted: false });
  });

  it("a signature from a different secret of the same length is refused", () => {
    const headers = signInternalRequest("x".repeat(40), "1.1.1.1", now);
    expect(verifyInternalRequest(secret, headers, now).trusted).toBe(false);
  });
});
