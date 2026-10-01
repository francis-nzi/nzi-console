import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import { validateDatabaseBoundary, type DatabaseBoundaryConfig } from "./databaseBoundary";
import { TenantContextError } from "./errors";

export type RuntimeDatabaseRole = "nzi_console_app" | "nzi_console_worker" | "nzi_console_auth";
export type Queryable = { query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> };
export type PoolLike = { connect(): Promise<PoolClient> };

export function createIsolatedPool(config: DatabaseBoundaryConfig, overrides: Omit<PoolConfig, "connectionString"> = {}): Pool {
  const url = validateDatabaseBoundary(config);
  return new Pool({ connectionString: url.toString(), max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ...overrides });
}

/**
 * One transaction client, one query at a time.
 *
 * A pg client runs one query at a time and has always queued the rest — but asking it to (calling `query` while
 * another is in flight) is deprecated, and pg@9 refuses it. Readers here gather with `Promise.all` on the one client
 * they are given, so the queue is made explicit: each query starts when the one before it has settled, in the order
 * asked, exactly as pg ordered them. A failure is still the caller's to see; it does not stop the queue.
 */
export function serialisedQueryable(client: Queryable): Queryable {
  let tail: Promise<unknown> = Promise.resolve();
  const query = <T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> => {
    const run = tail.then(() => client.query<T>(text, values));
    tail = run.catch(() => undefined);
    return run;
  };
  return { query };
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
    const result = await work(serialisedQueryable(client));
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

/**
 * The background worker's own tenant context. A separate role from the console's, with a
 * much narrower grant: it reads plans, clients and contacts, and writes only the outbox and
 * the automation log. A worker that ran as `nzi_console_app` could edit a client's plan
 * while reminding them about it.
 */
export function withTenantWorker<T>(pool: PoolLike, organisationId: string, work: (client: Queryable) => Promise<T>): Promise<T> {
  return withTenantTransaction(pool, organisationId, "nzi_console_worker", "write", work);
}

export function withAuthTransaction<T>(pool: PoolLike, mode: "read" | "write", work: (client: Queryable) => Promise<T>): Promise<T> {
  return withTenantTransaction(pool, "authentication", "nzi_console_auth", mode, work);
}
