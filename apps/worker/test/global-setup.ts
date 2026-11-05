import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, seed } from "@app/db";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { GenericContainer, Wait } from "testcontainers";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Connection string to the maintenance database of the test PostgreSQL. */
    pgAdminUrl: string;
    /** redis://:password@host:port (no database number) */
    redisUrl: string;
    /** Throw-away secret for signing calls between our programs, new on every run. */
    internalSecret: string;
    seedPasswords: { admin: string; user: string };
  }
}

const dbPackage = fileURLToPath(new URL("../../../packages/db", import.meta.url));

function withDatabase(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * One real PostgreSQL 16 and one real Redis 7 for the whole run. All passwords and secrets are made up fresh here
 * (nothing secret is written in the code). `template_seeded` is a migrated, seeded database; every test copies it.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const random = () => randomBytes(18).toString("hex");
  const pgPassword = random();
  const redisPassword = random();
  const seedPasswords = { admin: `a-${random()}`, user: `u-${random()}` };

  const postgres = await new PostgreSqlContainer("postgres:16-alpine").withPassword(pgPassword).withCommand(["postgres", "-c", "max_connections=300", "-c", "fsync=off"]).start();
  const redis = await new GenericContainer("redis:7-alpine")
    .withCommand(["redis-server", "--requirepass", redisPassword])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();

  const adminUrl = postgres.getConnectionUri();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query("CREATE DATABASE template_seeded");
  await admin.end();
  const templateUrl = withDatabase(adminUrl, "template_seeded");
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { cwd: dbPackage, env: { ...process.env, DATABASE_URL: templateUrl }, stdio: "pipe" });
  const db = createDb(templateUrl, { statementTimeoutMs: 120_000 });
  try {
    await seed(db, { adminPassword: seedPasswords.admin, userPassword: seedPasswords.user });
  } finally {
    await db.$disconnect();
  }

  // A template can only be copied when nobody is connected to it; the seed's pooled connections close a moment late.
  const cleaner = new Client({ connectionString: adminUrl });
  await cleaner.connect();
  await cleaner.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'template_seeded' AND pid <> pg_backend_pid()");
  await cleaner.end();

  project.provide("pgAdminUrl", adminUrl);
  project.provide("redisUrl", `redis://:${redisPassword}@${redis.getHost()}:${redis.getMappedPort(6379)}`);
  project.provide("internalSecret", random() + random());
  project.provide("seedPasswords", seedPasswords);
  return async () => {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
  };
}
