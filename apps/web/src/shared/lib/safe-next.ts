/** Where to go after logging in. Only a path on this site is accepted; anything else (https://evil.example, //evil.example) becomes "/". */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  // no control characters (line breaks, NUL ...): they have no place in an address
  for (const char of value) if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return "/";
  return value;
}
