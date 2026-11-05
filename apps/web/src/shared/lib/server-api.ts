import "server-only";
import { signInternalRequest } from "@app/shared/internal";
import { cookies, headers } from "next/headers";
import { apiUrl, internalSecret } from "./server-env";

export type Loaded<T> = { kind: "ok"; data: T } | { kind: "not-found" } | { kind: "unavailable" };

/** The visitor's address as nginx saw it, to be passed on (signed) so the api's rate limit counts the visitor, not this server. */
async function visitorIp(): Promise<string | undefined> {
  const forwarded = (await headers()).get("x-forwarded-for");
  return forwarded?.split(",").at(-1)?.trim() || undefined;
}

/**
 * Public data for pages anybody may see (event list, event card). Next.js keeps the answer for `revalidate` seconds and
 * forgets it at once when the tag is revalidated (an edit through the form, or the worker after any change).
 * No cookie and no visitor address go with this request - they would make every visitor's copy different. The shared
 * copy is protected from abuse by nginx (per-visitor page limit) and by the api's own caches.
 */
export async function loadPublic<T>(path: string, tags: string[], revalidate = 5): Promise<Loaded<T>> {
  try {
    const response = await fetch(`${apiUrl()}${path}`, { next: { revalidate, tags }, signal: AbortSignal.timeout(4000) });
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "unavailable" };
    return { kind: "ok", data: (await response.json()) as T };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Data that belongs to one visitor: never stored by Next.js, sent with the visitor's own cookie, counted against their address. */
export async function loadPrivate<T>(path: string): Promise<Loaded<T> | { kind: "unauthenticated" } | { kind: "forbidden" }> {
  try {
    const cookie = (await cookies()).toString();
    const ip = await visitorIp();
    const response = await fetch(`${apiUrl()}${path}`, {
      cache: "no-store",
      headers: { cookie, ...signInternalRequest(internalSecret(), ip) },
      signal: AbortSignal.timeout(4000),
    });
    if (response.status === 401) return { kind: "unauthenticated" };
    if (response.status === 403) return { kind: "forbidden" };
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "unavailable" };
    return { kind: "ok", data: (await response.json()) as T };
  } catch {
    return { kind: "unavailable" };
  }
}

/** A change made on behalf of the logged-in visitor (used by Server Actions). */
export async function sendPrivate(path: string, method: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const cookie = (await cookies()).toString();
  const ip = await visitorIp();
  try {
    const response = await fetch(`${apiUrl()}${path}`, {
      method,
      cache: "no-store",
      headers: { "content-type": "application/json", cookie, ...signInternalRequest(internalSecret(), ip) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // no JSON body
    }
    return { status: response.status, body: payload };
  } catch {
    return { status: 503, body: { code: "NOT_READY", message: "The service is temporarily unavailable. Try again in a moment." } };
  }
}
