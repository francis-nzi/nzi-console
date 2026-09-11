// Test support for NZC-022: a staff grant for a command context, and a fake-pool
// wrapper that answers the command runner's tenant/ownership lookup (`nzi:access`).
import { commandGrantForRole, type StaffRole } from "@nzi/contracts";

export const staffGrant = (role: StaffRole, organisationId: string, userId: string) => commandGrantForRole(role, organisationId, userId);

type FakeClient = { query(sql: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>; release(): void };
type FakePool = { connect(): Promise<unknown> };

/**
 * Wraps a fake pool so the runner's `nzi:access` statement resolves: the record is in
 * the caller's tenant (`organisationId`) and belongs to `clientId`, owned by
 * `ownerUserId`. Another tenant's lookup returns no row — refused, as under RLS.
 */
export function withAccess<P>(pool: P, options: { organisationId?: string; clientId?: string; ownerUserId?: string | null } = {}): P {
  const organisationId = options.organisationId ?? "org-a";
  const inner = pool as unknown as FakePool;
  return {
    ...(pool as object),
    async connect() {
      const client = (await inner.connect()) as FakeClient;
      return {
        ...client,
        async query(sql: string, values?: readonly unknown[]) {
          if (sql.includes("/* nzi:access */")) {
            return { rows: values?.[0] === organisationId ? [{ client_id: options.clientId ?? "client-a", owner_user_id: options.ownerUserId ?? null }] : [] };
          }
          return client.query(sql, values);
        },
        release: () => client.release(),
      };
    },
  } as unknown as P;
}
