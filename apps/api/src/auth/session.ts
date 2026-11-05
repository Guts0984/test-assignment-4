import type { UserRole } from "@app/shared";
import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

export const SESSION_COOKIE = "sid";

export type SessionData = { userId: string; email: string; role: UserRole };

const keyOf = (id: string): string => `sess:${createHash("sha256").update(id).digest("hex")}`;

/** Reads the value of one cookie from the Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Sessions live in Redis, so every api instance sees them. The cookie holds a random 256-bit id; Redis holds only a hash
 * of it, so a copy of Redis' data cannot be used to log in. An unused session expires on its own; each use extends it.
 */
export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async create(data: SessionData): Promise<string> {
    const id = randomBytes(32).toString("base64url");
    await this.redis.set(keyOf(id), JSON.stringify(data), "EX", this.ttlSeconds);
    return id;
  }

  async get(id: string): Promise<SessionData | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const raw = await this.redis.getex(keyOf(id), "EX", this.ttlSeconds);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  async destroy(id: string): Promise<void> {
    if (/^[A-Za-z0-9_-]{43}$/.test(id)) await this.redis.del(keyOf(id));
  }
}
