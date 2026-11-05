import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "../infra/logger";

/** How long something may live in each layer. A "missing" answer (404) is kept too, but for a shorter time. */
export type CachePolicy = {
  memoryMs: number;
  redisSeconds: number;
  missingMemoryMs: number;
  missingRedisSeconds: number;
};

type Entry = { value: unknown; expiresAt: number };

const GENERATION_KEY = "gen:events";
const LOCK_MS = 5000;
const WAIT_FOR_OTHER_LOADER_MS = 3000;

// Release a lock only if it is still ours (it may have expired and been taken by someone else).
const UNLOCK_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two layers of cache for data that everybody sees the same way:
 *   1. memory of this process (fastest, per instance),
 *   2. Redis (shared by all instances).
 *
 * How a change on one instance becomes visible on the other at once: there is ONE generation number in Redis. Every
 * cache key contains it ("ev:g7:42"). A change bumps the number, so all old keys are simply never asked for again,
 * on every instance, with no messages that could arrive late. Each read starts by reading the number (one tiny Redis call).
 * Old keys die by their own expiry.
 *
 * Many identical requests on a cold cache cause ONE database query:
 *   - inside a process, they share one promise;
 *   - between processes, one takes a short Redis lock and loads, the others wait for the result to appear in Redis.
 *
 * If Redis is down the cache is skipped and the database is asked directly: slower, but never wrong.
 */
export class TwoLevelCache {
  private readonly memory = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly maxEntries = 2000,
  ) {}

  /** Everything cached so far becomes invalid, on every instance. Call it after the data changed. */
  async invalidateAll(): Promise<void> {
    await this.redis.incr(GENERATION_KEY);
  }

  private async generation(): Promise<number | null> {
    try {
      return Number((await this.redis.get(GENERATION_KEY)) ?? 0);
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "cache generation unavailable, reading the database directly");
      return null;
    }
  }

  /** Returns the cached value for `key`, or runs `load` (once, however many ask) and caches the result. `null` means "not found". */
  async get<T>(namespace: string, key: string, policy: CachePolicy, load: () => Promise<T | null>): Promise<T | null> {
    const generation = await this.generation();
    if (generation === null) return load();
    const fullKey = `${namespace}:g${generation}:${key}`;

    const hit = this.memory.get(fullKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T | null;

    const running = this.inFlight.get(fullKey);
    if (running) return (await running) as T | null;

    const work = this.fill<T>(fullKey, policy, load).finally(() => this.inFlight.delete(fullKey));
    this.inFlight.set(fullKey, work);
    return work;
  }

  private remember(fullKey: string, value: unknown, ms: number): void {
    if (this.memory.size >= this.maxEntries) {
      // Forget the oldest tenth (Map keeps insertion order).
      let drop = Math.ceil(this.maxEntries / 10);
      for (const oldest of this.memory.keys()) {
        if (drop-- <= 0) break;
        this.memory.delete(oldest);
      }
    }
    this.memory.set(fullKey, { value, expiresAt: Date.now() + ms });
  }

  private async fill<T>(fullKey: string, policy: CachePolicy, load: () => Promise<T | null>): Promise<T | null> {
    const fromRedis = await this.readRedis<T>(fullKey, policy);
    if (fromRedis.found) return fromRedis.value;

    const lockKey = `lock:${fullKey}`;
    const token = randomUUID();
    const deadline = Date.now() + WAIT_FOR_OTHER_LOADER_MS;
    for (;;) {
      const locked = await this.redis.set(lockKey, token, "PX", LOCK_MS, "NX").then((r) => r === "OK", () => false);
      if (locked) {
        try {
          const value = await load();
          await this.writeRedis(fullKey, value, policy);
          this.remember(fullKey, value, value === null ? policy.missingMemoryMs : policy.memoryMs);
          return value;
        } finally {
          await this.redis.eval(UNLOCK_SCRIPT, 1, lockKey, token).catch(() => undefined);
        }
      }
      // Another process is loading it right now: wait for its result to show up.
      await sleep(25);
      const waited = await this.readRedis<T>(fullKey, policy);
      if (waited.found) return waited.value;
      if (Date.now() > deadline) {
        // The other loader seems stuck or failed: do not wait any longer, ask the database ourselves.
        const value = await load();
        this.remember(fullKey, value, value === null ? policy.missingMemoryMs : policy.memoryMs);
        return value;
      }
    }
  }

  private async readRedis<T>(fullKey: string, policy: CachePolicy): Promise<{ found: true; value: T | null } | { found: false }> {
    try {
      const raw = await this.redis.get(fullKey);
      if (raw === null) return { found: false };
      const value = (JSON.parse(raw) as { v: T | null }).v;
      this.remember(fullKey, value, value === null ? policy.missingMemoryMs : policy.memoryMs);
      return { found: true, value };
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "cache read failed");
      return { found: false };
    }
  }

  private async writeRedis(fullKey: string, value: unknown, policy: CachePolicy): Promise<void> {
    try {
      await this.redis.set(fullKey, JSON.stringify({ v: value }), "EX", value === null ? policy.missingRedisSeconds : policy.redisSeconds);
    } catch (error) {
      this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, "cache write failed");
    }
  }
}
