import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Calls between our own programs (web -> api, worker -> web) prove who they are with a signature
 * made from a secret that only those programs know. A browser cannot make one, so it cannot
 * pretend to be another visitor's address. Server-only code: it uses Node's crypto.
 */
export const INTERNAL_IP_HEADER = "x-end-user-ip";
export const INTERNAL_TIMESTAMP_HEADER = "x-internal-timestamp";
export const INTERNAL_SIGNATURE_HEADER = "x-internal-signature";

/** A signature older than this is ignored, so a copied one cannot be used for long. */
export const INTERNAL_MAX_AGE_MS = 5 * 60 * 1000;

const sign = (secret: string, timestamp: string, ip: string): string =>
  createHmac("sha256", secret).update(`${timestamp}.${ip}`).digest("hex");

/** The headers a trusted caller adds. Without `ip` the call is "ours, not on behalf of a visitor". */
export function signInternalRequest(secret: string, ip?: string, now: number = Date.now()): Record<string, string> {
  const timestamp = String(now);
  const headers: Record<string, string> = {
    [INTERNAL_TIMESTAMP_HEADER]: timestamp,
    [INTERNAL_SIGNATURE_HEADER]: sign(secret, timestamp, ip ?? ""),
  };
  if (ip) headers[INTERNAL_IP_HEADER] = ip;
  return headers;
}

export type InternalCheck = { trusted: false } | { trusted: true; ip: string | undefined };

type HeaderValue = string | string[] | undefined;
const single = (value: HeaderValue): string | undefined => (typeof value === "string" ? value : undefined);

/** Is this request from one of our programs? If so, which visitor address does it speak for? */
export function verifyInternalRequest(
  secret: string,
  headers: Record<string, HeaderValue>,
  now: number = Date.now(),
): InternalCheck {
  const timestamp = single(headers[INTERNAL_TIMESTAMP_HEADER]);
  const signature = single(headers[INTERNAL_SIGNATURE_HEADER]);
  if (!timestamp || !signature || !/^\d{10,16}$/.test(timestamp)) return { trusted: false };
  if (Math.abs(now - Number(timestamp)) > INTERNAL_MAX_AGE_MS) return { trusted: false };

  const ip = single(headers[INTERNAL_IP_HEADER]) ?? "";
  const expected = Buffer.from(sign(secret, timestamp, ip), "hex");
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { trusted: false };
  return { trusted: true, ip: ip === "" ? undefined : ip };
}
