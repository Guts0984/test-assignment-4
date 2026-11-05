import { ErrorCode } from "@app/shared";
import type { Redis } from "ioredis";
import type { Logger } from "../infra/logger";
import { AppError } from "./errors";

// Atomic "count this request, and start the window on the first one". One Lua script = one step in Redis, so two api
// instances (or 200 parallel requests) can never read the same number and both slip under the limit.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export type Hit = { count: number; retryAfterSeconds: number };

/** Counts events per key in Redis, so the count is shared by every api instance. */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  /** Counts one event. If Redis is unavailable the request is let through (and the problem logged): losing the limit
   *  for a few seconds is better than refusing every visitor. */
  async hit(key: string, windowSeconds: number): Promise<Hit | null> {
    try {
      const [count, ttl] = (await this.redis.eval(HIT_SCRIPT, 1, key, windowSeconds)) as [number, number];
      return { count, retryAfterSeconds: Math.max(ttl, 1) };
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error.message : String(error), key: key.split(":")[0] }, "rate limiter unavailable, request allowed");
      return null;
    }
  }

  /** Reads a counter without changing it. */
  async peek(key: string): Promise<Hit | null> {
    try {
      const [value, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
      return { count: Number(value ?? 0), retryAfterSeconds: Math.max(ttl, 1) };
    } catch {
      return null;
    }
  }

  /** Counts one event and throws 429 when more than `max` happened in the window. */
  async limit(scope: string, who: string, max: number, windowSeconds: number): Promise<void> {
    const hit = await this.hit(`rl:${scope}:${who}`, windowSeconds);
    if (hit && hit.count > max) throw tooMany(hit.retryAfterSeconds);
  }
}

export function tooMany(retryAfterSeconds: number): AppError {
  return new AppError(429, ErrorCode.RATE_LIMITED, "Too many requests. Try again later.", { retryAfterSeconds }, { "Retry-After": String(retryAfterSeconds) });
}
