import "server-only";

// Settings that only the server may know. The "server-only" import makes the build fail if a browser file imports this one,
// and none of these names starts with NEXT_PUBLIC_, so none of them can end up in the browser's files.

/** Where the api listens inside the Docker network. Not a secret, so it may have a default. */
export function apiUrl(): string {
  return process.env["API_URL"] ?? "http://api:4000";
}

/**
 * Signs our calls to the api (the visitor's address) and checks the worker's calls to us. It has NO default: a missing or
 * short secret is an error, never a guessable fallback. Read when needed (not at build time, when there are no secrets).
 */
export function internalSecret(): string {
  const secret = process.env["INTERNAL_SECRET"];
  if (!secret || secret.length < 32) throw new Error("INTERNAL_SECRET must be set (at least 32 characters)");
  return secret;
}
