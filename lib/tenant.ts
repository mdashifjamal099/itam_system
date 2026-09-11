import type { NeonQueryPromise } from "@neondatabase/serverless";
import { sql } from "./db";

/** What the `sql` template tag produces for the HTTP driver's default options. */
type Query = NeonQueryPromise<false, false, Record<string, unknown>[]>;

/**
 * Runs queries with transaction-local tenant context.
 *
 * The SET must live in the same transaction as the query. Neon's pooled
 * endpoint (PgBouncer, transaction mode) can hand the same backend to a
 * different tenant once a transaction ends, so a session-level SET would leak
 * across tenants. set_config(..., is_local => true) is SET LOCAL in function
 * form and is discarded at COMMIT.
 */
export async function withTenant<T = Record<string, unknown>>(
  orgId: string,
  query: Query,
): Promise<T[]> {
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.org_id', ${orgId}, true)` as Query,
    query,
  ]);
  return rows as T[];
}

/** Several statements under one tenant context, in one transaction. */
export async function withTenantBatch(orgId: string, queries: Query[]): Promise<unknown[][]> {
  const results = await sql.transaction([
    sql`SELECT set_config('app.org_id', ${orgId}, true)` as Query,
    ...queries,
  ]);
  return results.slice(1) as unknown[][];
}

/**
 * System context for scheduled jobs. Grants exactly one thing: the ability to
 * enumerate organizations, so a cron can then scope itself to each tenant
 * normally. Never reachable from a user request path.
 */
export async function asSystem<T = Record<string, unknown>>(query: Query): Promise<T[]> {
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.system', '1', true)` as Query,
    query,
  ]);
  return rows as T[];
}

/** Cross-tenant context for the outbox drainer. */
export async function asDrainer<T = Record<string, unknown>>(query: Query): Promise<T[]> {
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.drainer', '1', true)` as Query,
    query,
  ]);
  return rows as T[];
}

/** Every tenant id — the entry point for any scheduled sweep. */
export async function allOrgIds(): Promise<string[]> {
  const rows = await asSystem<{ id: string }>(sql`SELECT id FROM organization ORDER BY created_at`);
  return rows.map((r) => r.id);
}
