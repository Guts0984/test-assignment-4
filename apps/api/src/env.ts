import { issuesToFieldErrors } from "@app/shared";
import { z } from "zod";

/** Everything the api reads from its environment. Checked once at startup: a wrong value stops the process with a clear message. */
const envSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
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
