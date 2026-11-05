import { issuesToFieldErrors } from "@app/shared";
import { z } from "zod";

const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

/**
 * Everything the api reads from its environment. Checked once at startup: a wrong value stops the process with a
 * clear message. Secrets (the database and Redis URLs carry passwords, INTERNAL_SECRET signs calls between our own
 * programs) have NO default: a missing secret stops the process instead of running with a guessable one.
 */
const envSchema = z.object({
  API_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgresql:// address"),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// address"),
  INTERNAL_SECRET: z.string().min(32, "must be at least 32 characters"),

  /** Set to "true" when the site is served over https: the session cookie then gets the Secure flag. */
  COOKIE_SECURE: flag,
  SESSION_TTL_SECONDS: positiveInt(7 * 24 * 3600),

  /**
   * Which direct neighbours may tell us the visitor's address through X-Forwarded-For (a list for Express "trust proxy").
   * Our nginx overwrites that header with the real address, and only nginx can reach the api.
   * "none" ignores the header completely.
   */
  TRUST_PROXY: z.string().default("loopback,linklocal,uniquelocal"),

  /** Requests per visitor address and window, shared by all api instances. */
  RATE_LIMIT_MAX: positiveInt(300),
  RATE_LIMIT_WINDOW_SECONDS: positiveInt(10),
  /** Wrong passwords for ONE account from ONE visitor address, per window, before that address is stopped for that account. */
  LOGIN_FAILURES_MAX: positiveInt(20),
  /** Wrong passwords from one visitor address in total (any accounts), per window. Much higher: it only stops a scan over many accounts. */
  LOGIN_FAILURES_PER_IP_MAX: positiveInt(200),
  /** Login attempts (right or wrong) from one address in 10 seconds: stops guessing in parallel before the counters above notice. */
  LOGIN_BURST_MAX: positiveInt(30),
  /** New accounts from one visitor address per hour. */
  REGISTER_MAX_PER_HOUR: positiveInt(300),
  LOGIN_FAILURES_WINDOW_SECONDS: positiveInt(900),

  /** How long a hold keeps its seats. */
  HOLD_TTL_SECONDS: positiveInt(600),
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

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = parseEnv(source);
  if (result.ok) return result.env;
  console.error(
    ["api cannot start: invalid configuration", ...result.problems.map((p) => `  - ${p}`), "Check your .env file (see .env.example)."].join("\n"),
  );
  process.exit(1);
}
