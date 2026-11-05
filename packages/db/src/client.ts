import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

export type Db = PrismaClient;

/**
 * Creates a database client. `connectionTimeoutMillis` stops a request from hanging when PostgreSQL is
 * unreachable; `statement_timeout` stops a single slow query from running for ever (both are required
 * by the assignment: no call to the database may hang for more than a few seconds).
 */
export function createDb(connectionString: string): Db {
  const adapter = new PrismaPg({
    connectionString,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    max: 10,
  });
  return new PrismaClient({ adapter });
}
