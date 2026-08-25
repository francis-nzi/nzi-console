import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import { validateDatabaseBoundary, type DatabaseBoundaryConfig } from "./databaseBoundary";
import { TenantContextError } from "./errors";

export type RuntimeDatabaseRole = "nzi_console_app" | "nzi_console_worker";
export type Queryable = { query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> };
export type PoolLike = { connect(): Promise<PoolClient> };

export function createIsolatedPool(config: DatabaseBoundaryConfig, overrides: Omit<PoolConfig, "connectionString"> = {}): Pool {
  const url = validateDatabaseBoundary(config);
  return new Pool({ connectionString: url.toString(), max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ...overrides });
}

export async function withTenantTransaction<T>(
  pool: PoolLike,
  organisationId: string,
  role: RuntimeDatabaseRole,
  mode: "read" | "write",
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  if (!organisationId.trim()) throw new TenantContextError();
  const client = await pool.connect();
  try {
    await client.query(mode === "read" ? "BEGIN READ ONLY" : "BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [organisationId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function withTenantRead<T>(pool: PoolLike, organisationId: string, work: (client: Queryable) => Promise<T>): Promise<T> {
  return withTenantTransaction(pool, organisationId, "nzi_console_app", "read", work);
}

export function withTenantWrite<T>(pool: PoolLike, organisationId: string, work: (client: Queryable) => Promise<T>): Promise<T> {
  return withTenantTransaction(pool, organisationId, "nzi_console_app", "write", work);
}
