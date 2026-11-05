import { issuesToFieldErrors } from "@app/shared";
import { z } from "zod";

/**
 * Everything the worker reads from its environment, checked once at startup. Secrets have NO default:
 * a missing one stops the process instead of running with a guessable value.
 */
const envSchema = z.object({
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(4100),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgresql:// address"),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// address"),
  INTERNAL_SECRET: z.string().min(32, "must be at least 32 characters"),
  /** Where the web app listens inside the Docker network; the worker asks it to forget cached pages here. */
  WEB_URL: z.string().regex(/^https?:\/\//, "must be an http:// address").default("http://web:3000"),

  /** How often expired holds are looked for, and the outbox is read (milliseconds). */
  EXPIRE_EVERY_MS: z.coerce.number().int().min(100).default(3000),
  OUTBOX_EVERY_MS: z.coerce.number().int().min(100).default(1000),
  /** The second, delayed "forget the cached page" call (it catches a page rebuilt from slightly old data). */
  REVALIDATE_AGAIN_AFTER_MS: z.coerce.number().int().min(0).default(3000),
  /** First pause between retries of a call to the web app; it doubles each time. */
  REVALIDATE_RETRY_MS: z.coerce.number().int().min(10).default(1000),
});

export type Env = z.infer<typeof envSchema>;
export type EnvResult = { ok: true; env: Env } | { ok: false; problems: string[] };

export function parseEnv(source: NodeJS.ProcessEnv): EnvResult {
  const result = envSchema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };
  const fields = issuesToFieldErrors(result.error.issues);
  const problems = Object.entries(fields).flatMap(([name, messages]) =>
    messages.map((message) => (message.includes(name) ? message : `${name} ${message}`)),
  );
  return { ok: false, problems };
}

/** Reads `process.env`. If anything is missing or wrong, says what and stops the process. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = parseEnv(source);
  if (result.ok) return result.env;
  console.error(
    ["worker cannot start: invalid configuration", ...result.problems.map((p) => `  - ${p}`), "Check your .env file (see .env.example)."].join("\n"),
  );
  process.exit(1);
}
