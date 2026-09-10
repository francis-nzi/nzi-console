import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { VersionConflictError } from "./errors";

async function requireSite(db: Queryable, organisationId: string, siteId: string) {
  const result = await db.query<{ client_id: string; version: number; in_service_from: Date | string; vacated_effective: Date | string | null }>(`SELECT client_id,version,in_service_from,vacated_effective FROM nzi_console.client_sites WHERE organisation_id=$1 AND site_id=$2 FOR UPDATE`, [organisationId, siteId]);
  if (!result.rows[0]) throw new CommandValidationError([{ field: "siteId", code: "NOT_FOUND", message: "Client site was not found." }]);
  return result.rows[0];
}

export async function addSite(pool: PoolLike, input: CommandInputMap["site.create"], context: CommandContext): Promise<StoredOutcome<{ siteId: string; name: string }>> {
  return runPostgresCommand(pool, "site.create", input, context, async (db) => {
    const job = await db.query<{ client_id: string }>(`SELECT client_id FROM nzi_console.jobs WHERE organisation_id=$1 AND job_id=$2`, [context.organisationId, input.jobId]);
    if (!job.rows[0]) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "Job was not found." }]);
    const siteId = randomUUID();
    await db.query(`INSERT INTO nzi_console.client_sites (organisation_id,site_id,client_id,name,created_by,in_service_from,is_registered_office) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [context.organisationId, siteId, job.rows[0].client_id, input.name.trim(), context.actorId, input.inServiceFrom ?? new Date().toISOString().slice(0, 10), input.isRegisteredOffice ?? false]);
    return { data: { siteId, name: input.name.trim() }, entityType: "client_site", entityId: siteId, topic: "client.site.created" };
  });
}

export async function editSite(pool: PoolLike, input: CommandInputMap["site.edit"], context: CommandContext) {
  return runPostgresCommand(pool, "site.edit", input, context, async (db) => {
    const current = await requireSite(db, context.organisationId, input.siteId);
    if (current.version !== input.expectedVersion) throw new VersionConflictError();
    if (current.vacated_effective !== null && input.inServiceFrom > current.vacated_effective) throw new CommandValidationError([{ field: "inServiceFrom", code: "INVALID_RANGE", message: "In-service date must precede its vacated effective date." }]);
    await db.query(`UPDATE nzi_console.client_sites SET name=$1,in_service_from=$2,version=version+1 WHERE organisation_id=$3 AND site_id=$4 AND version=$5`, [input.name.trim(), input.inServiceFrom, context.organisationId, input.siteId, input.expectedVersion]);
    return { data: { siteId: input.siteId, version: input.expectedVersion + 1 }, entityType: "client_site", entityId: input.siteId, topic: "client.site.updated" };
  });
}

export async function setRegisteredOffice(pool: PoolLike, input: CommandInputMap["site.registeredOffice"], context: CommandContext) {
  return runPostgresCommand(pool, "site.registeredOffice", input, context, async (db) => {
    const current = await requireSite(db, context.organisationId, input.siteId);
    if (current.version !== input.expectedVersion) throw new VersionConflictError();
    if (input.isRegisteredOffice) await db.query(`UPDATE nzi_console.client_sites SET is_registered_office=false,version=version+1 WHERE organisation_id=$1 AND client_id=$2 AND site_id<>$3 AND is_registered_office=true`, [context.organisationId, current.client_id, input.siteId]);
    await db.query(`UPDATE nzi_console.client_sites SET is_registered_office=$1,version=version+1 WHERE organisation_id=$2 AND site_id=$3 AND version=$4`, [input.isRegisteredOffice, context.organisationId, input.siteId, input.expectedVersion]);
    return { data: { siteId: input.siteId, isRegisteredOffice: input.isRegisteredOffice }, entityType: "client_site", entityId: input.siteId, topic: "client.site.registered_office_changed" };
  });
}

export async function vacateSite(pool: PoolLike, input: CommandInputMap["site.vacate"], context: CommandContext) {
  return runPostgresCommand(pool, "site.vacate", input, context, async (db) => {
    const current = await requireSite(db, context.organisationId, input.siteId);
    if (current.version !== input.expectedVersion) throw new VersionConflictError();
    const dateOnly = (value: Date | string) => value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}` : String(value).slice(0, 10);
    if (input.effectiveDate < dateOnly(current.in_service_from)) throw new CommandValidationError([{ field: "effectiveDate", code: "INVALID_RANGE", message: "Vacated effective date must not precede the in-service date." }]);
    await db.query(`UPDATE nzi_console.client_sites SET vacated_effective=$1,version=version+1 WHERE organisation_id=$2 AND site_id=$3 AND version=$4`, [input.effectiveDate, context.organisationId, input.siteId, input.expectedVersion]);
    return { data: { siteId: input.siteId, vacatedEffective: input.effectiveDate }, entityType: "client_site", entityId: input.siteId, topic: "client.site.vacated" };
  });
}

export async function reinstateSite(pool: PoolLike, input: CommandInputMap["site.reinstate"], context: CommandContext) {
  return runPostgresCommand(pool, "site.reinstate", input, context, async (db) => {
    const current = await requireSite(db, context.organisationId, input.siteId);
    if (current.version !== input.expectedVersion) throw new VersionConflictError();
    await db.query(`UPDATE nzi_console.client_sites SET vacated_effective=NULL,version=version+1 WHERE organisation_id=$1 AND site_id=$2 AND version=$3`, [context.organisationId, input.siteId, input.expectedVersion]);
    return { data: { siteId: input.siteId }, entityType: "client_site", entityId: input.siteId, topic: "client.site.reinstated" };
  });
}