import { makeApiError } from "./api-error";

/**
 * Calls the api from the browser. The address is relative ("/api/..."): nginx forwards it to the api. The browser never
 * learns the api's real address, and the session cookie goes along automatically.
 */
export async function apiRequest<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    credentials: "same-origin",
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (response.status === 204) return undefined as T;
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // An answer without JSON (for example a 502 page from a proxy) is described below by its status.
  }
  if (!response.ok) throw makeApiError(response.status, payload);
  return payload as T;
}
