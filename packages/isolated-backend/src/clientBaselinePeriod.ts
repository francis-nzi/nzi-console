// Addendum B.4 (ruled 25 Nov 2026) — a job that is its client's baseline year moves its period; the job offers the same
// change to the client's baseline period. That is client.update — the existing path — with the whole record as held and only
// the baseline period moved: a governed re-baseline when the baseline has figures (baseline.rebaseline, a reason, the prior
// kept), the initial baseline's audited edit when it is still pending.
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import { withTenantRead, type PoolLike } from "./postgres";
import { CommandValidationError, updateClient, type StoredOutcome, type UpdateClientResult } from "./postgresCommands";
import { listAllClients } from "./readModels";

export async function moveClientBaselinePeriod(pool: PoolLike, input: { clientId: string; expectedVersion?: number; periodStart: string; periodEnd: string }, context: CommandContext): Promise<StoredOutcome<UpdateClientResult>> {
  const [client] = await withTenantRead(pool, context.organisationId, (db) => listAllClients(db, input.clientId));
  if (!client) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "Client was not found." }]);
  // The client as read now (or at the version the caller saw); client.update's own version check refuses a stale one.
  const update = {
    clientId: input.clientId, expectedVersion: input.expectedVersion ?? client.version, name: client.name, status: client.status, sector: client.sector,
    location: client.location, owner: client.owner, ...client.profile,
    baselinePeriodStart: input.periodStart, baselinePeriodEnd: input.periodEnd,
  } as CommandInputMap["client.update"];
  return updateClient(pool, update, context);
}
