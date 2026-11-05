import { verifyInternalRequest } from "@app/shared/internal";
import { isIP } from "node:net";
import type { Request } from "express";

/** "::ffff:1.2.3.4" is the IPv4 address 1.2.3.4 seen through an IPv6 socket. */
export function normalizeIp(address: string): string {
  return address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

/**
 * The address of the real visitor, which is what the rate limit counts.
 *
 * 1. A call from our own web server (server-side rendering) names the visitor in a header, but only counts if it is
 *    signed with INTERNAL_SECRET. A browser cannot sign, so a made-up address in that header is ignored.
 * 2. Otherwise the address comes from Express (`req.ip`). Express reads X-Forwarded-For only when the direct neighbour is
 *    a trusted proxy (our nginx), and even then takes the entry added by that proxy, not the ones the browser wrote.
 *    nginx replaces the header with the address it saw. For any other sender the header is ignored.
 */
export function clientIp(req: Request, internalSecret: string): string {
  const check = verifyInternalRequest(internalSecret, req.headers);
  if (check.trusted && check.ip && isIP(check.ip) !== 0) return normalizeIp(check.ip);
  return normalizeIp(req.ip ?? req.socket.remoteAddress ?? "unknown");
}

/** Express "trust proxy" setting from the env value ("none" turns it off). */
export function parseTrustProxy(value: string): boolean | string[] {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length === 0 || parts.includes("none") ? false : parts;
}
