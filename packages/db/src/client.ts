import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "./generated/client";

export type Db = PrismaClient;

export type CreateDbOptions = {
  /** Called when the pool reports a broken connection (for example PostgreSQL restarted). Never throws. */
  onError?: (error: Error) => void;
  max?: number;
  /** Called with the SQL text of every query. For tests that count how many queries a request caused. */
  onQuery?: (sql: string) => void;
  /**
   * How long one statement may run (default 5 s). The seed raises it: while several seeders start at the same moment the
   * later ones wait for the first one's lock, and filling a slow disk can take longer than 5 s.
   */
  statementTimeoutMs?: number;
};

/**
 * Creates a database client.
 * - `connectionTimeoutMillis`: waiting for a connection never takes longer than 3 seconds (PostgreSQL down).
 * - `statement_timeout` (server side) and `query_timeout` (client side): a query never runs longer than 5-6 seconds,
 *   even if the network silently drops packets.
 * - The pool's `error` event is handled: an idle connection that dies when PostgreSQL restarts would otherwise be an
 *   unhandled error and stop the whole process.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): Db {
  const statementTimeoutMs = options.statementTimeoutMs ?? 5000;
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 3000,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + 1000,
    idle_in_transaction_session_timeout: 10_000,
    keepAlive: true,
    max: options.max ?? 10,
  });
  pool.on("error", (error) => options.onError?.(error));
  const adapter = new PrismaPg(pool);
  const { onQuery } = options;
  if (!onQuery) return new PrismaClient({ adapter });
  const client = new PrismaClient({ adapter, log: [{ emit: "event", level: "query" }] });
  // Prisma types `$on` only for statically known log settings; the cast states the one shape we use.
  (client as unknown as { $on(event: "query", handler: (event: { query: string }) => void): void }).$on("query", (event) => onQuery(event.query));
  return client;
}
