import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

export type Db = PrismaClient;

/**
 * Creates a database client. `connectionTimeoutMillis` stops a request from hanging when PostgreSQL is
 * unreachable; `statement_timeout` stops a single slow query from running for ever (both are required
 * by the assignment: no call to the database may hang for more than a few seconds).
 * The seed passes a longer `statementTimeoutMs`: several seeders started at once wait for one lock, and a slow disk can need more than 5 s.
 */
export function createDb(connectionString: string, options: { statementTimeoutMs?: number } = {}): Db {
  const adapter = new PrismaPg({
    connectionString,
    connectionTimeoutMillis: 3000,
    statement_timeout: options.statementTimeoutMs ?? 5000,
    max: 10,
  });
  return new PrismaClient({ adapter });
}
