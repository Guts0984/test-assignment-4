import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { createDb } from "../src/client";
import { seed } from "../src/seed";

export const SEED_PASSWORDS = { adminPassword: "test-admin-password", userPassword: "test-user-password" };

declare module "vitest" {
  export interface ProvidedContext {
    /** Connection string of the "postgres" maintenance database of the test container. */
    adminUrl: string;
  }
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function withDatabase(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function adminQuery(adminUrl: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * Starts ONE real PostgreSQL 16 for the whole test run and prepares two template databases:
 *   template_empty  - migrations applied, no data
 *   template_seeded - migrations applied and the seed run
 * Every test file copies a template into its own database (milliseconds), so files cannot disturb each other.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    // 200 simultaneous requests need more than the default 100 connections.
    .withCommand(["postgres", "-c", "max_connections=400", "-c", "fsync=off"])
    .start();
  const adminUrl = container.getConnectionUri();

  for (const name of ["template_empty", "template_seeded"]) {
    await adminQuery(adminUrl, `CREATE DATABASE ${name}`);
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: withDatabase(adminUrl, name) },
      stdio: "pipe",
    });
  }

  const seeded = createDb(withDatabase(adminUrl, "template_seeded"));
  try {
    await seed(seeded, SEED_PASSWORDS);
  } finally {
    await seeded.$disconnect();
  }

  project.provide("adminUrl", adminUrl);
  return async () => {
    await container.stop();
  };
}
