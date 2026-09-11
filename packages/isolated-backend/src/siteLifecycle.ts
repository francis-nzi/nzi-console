import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { VersionConflictError } from "./errors";
import { dateOnly } from "./dates";

/**
 * NZC-070 / NZC-071 — site lifecycle. Sites are effective-dated and never
 * hard-deleted; every change is one atomic, idempotent, audited command.
 */

type SiteRow = { client_id: string; name: string; version: number; is_registered_office: boolean; in_service_from: Date | string | null; vacated_effective: Date | string | null };
const ddmmyyyy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const invalid = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);

async function requireSite(db: Queryable, organisationId: string, siteId: string, expectedVersion: number) {
  const { rows } = await db.query<SiteRow>(`SELECT client_id,name,version,is_registered_office,in_service_from,vacated_effective FROM nzi_console.client_sites WHERE organisation_id=$1 AND site_id=$2 AND archived=false FOR UPDATE`, [organisationId, siteId]);
  const site = rows[0];
  if (!site) throw invalid("siteId", "NOT_FOUND", "Client site was not found.");
  if (site.version !== expectedVersion) throw new VersionConflictError();
  return {
    ...site,
    inServiceFrom: site.in_service_from === null ? null : dateOnly(site.in_service_from),
    vacatedEffective: site.vacated_effective === null ? null : dateOnly(site.vacated_effective),
  };
}

async function assertNameFree(db: Queryable, organisationId: string, clientId: string, name: string, exceptSiteId: string | null) {
  const { rows } = await db.query(`SELECT 1 FROM nzi_console.client_sites WHERE organisation_id=$1 AND client_id=$2 AND lower(trim(name))=lower(trim($3)) AND site_id IS DISTINCT FROM $4`, [organisationId, clientId, name, exceptSiteId]);
  if (rows[0]) throw invalid("name", "DUPLICATE", "This client already has a site with that name.");
}

async function assertRegisteredOfficeFree(db: Queryable, organisationId: string, clientId: string) {
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM nzi_console.client_sites WHERE organisation_id=$1 AND client_id=$2 AND is_registered_office=true AND archived=false`, [organisationId, clientId]);
  if (rows[0]) throw invalid("isRegisteredOffice", "REGISTERED_OFFICE_TAKEN", `${rows[0].name} is already the registered office. Reassign it from that site first.`);
}

/** Bumps the version and returns it; no row means a concurrent write won. */
async function bumpVersion(db: Queryable, organisationId: string, siteId: string, expectedVersion: number, set: string, values: readonly unknown[]): Promise<number> {
  const { rows } = await db.query<{ version: number }>(`UPDATE nzi_console.client_sites SET ${set}${set ? "," : ""}version=version+1 WHERE organisation_id=$1 AND site_id=$2 AND version=$3 RETURNING version`, [organisationId, siteId, expectedVersion, ...values]);
  if (!rows[0]) throw new VersionConflictError();
  return rows[0].version;
}

/** A unique-index race the pre-checks lost maps to the same validation error, never a raw 500. */
function uniqueViolation(error: unknown): CommandValidationError | null {
  if (!error || typeof error !== "object" || (error as { code?: string }).code !== "23505") return null;
  const constraint = (error as { constraint?: string }).constraint ?? "";
  return constraint === "client_sites_one_registered_office"
    ? invalid("isRegisteredOffice", "REGISTERED_OFFICE_TAKEN", "Another site is already the registered office.")
    : invalid("name", "DUPLICATE", "This client already has a site with that name.");
}

/**
 * The one `site.create`. From a job the in-service date defaults to that job's
 * reporting-period start; from the client workspace it is stated (null = in
 * service from before records).
 */
export async function createClientSite(pool: PoolLike, input: CommandInputMap["site.create"], context: CommandContext): Promise<StoredOutcome<{ siteId: string; name: string; clientId: string; inServiceFrom: string | null }>> {
  return runPostgresCommand(pool, "site.create", input, context, async (db) => {
    let clientId: string;
    let inServiceFrom: string | null;
    if (input.jobId) {
      const { rows } = await db.query<{ client_id: string; job_family: string; period_start: Date | string }>(`SELECT j.client_id,j.job_family,coalesce(c.reporting_from,j.start_date) AS period_start FROM nzi_console.jobs j LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id,c.job_id)=(j.organisation_id,j.job_id) WHERE j.organisation_id=$1 AND j.job_id=$2`, [context.organisationId, input.jobId]);
      const job = rows[0];
      if (!job) throw invalid("jobId", "NOT_FOUND", "Job was not found.");
      if (job.job_family !== "crp") throw invalid("jobId", "WRONG_FAMILY", "Sites are created from CRP jobs.");
      clientId = job.client_id;
      inServiceFrom = input.inServiceFrom !== undefined ? input.inServiceFrom : dateOnly(job.period_start);
    } else {
      const { rows } = await db.query<{ client_id: string }>(`SELECT client_id FROM nzi_console.clients WHERE organisation_id=$1 AND client_id=$2`, [context.organisationId, input.clientId]);
      if (!rows[0]) throw invalid("clientId", "NOT_FOUND", "Client was not found.");
      clientId = rows[0].client_id;
      inServiceFrom = input.inServiceFrom ?? null;
    }
    const name = input.name.trim();
    await assertNameFree(db, context.organisationId, clientId, name, null);
    if (input.isRegisteredOffice) await assertRegisteredOfficeFree(db, context.organisationId, clientId);
    const siteId = randomUUID();
    try {
      await db.query(`INSERT INTO nzi_console.client_sites (organisation_id,site_id,client_id,name,created_by,in_service_from,is_registered_office) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [context.organisationId, siteId, clientId, name, context.actorId, inServiceFrom, input.isRegisteredOffice ?? false]);
    } catch (error) {
      throw uniqueViolation(error) ?? error;
    }
    if (input.floorAreaM2 != null) {
      await db.query(`INSERT INTO nzi_console.client_site_floor_areas (organisation_id,floor_area_id,site_id,effective_from,floor_area_m2,recorded_by) VALUES ($1,$2,$3,NULL,$4,$5)`, [context.organisationId, randomUUID(), siteId, input.floorAreaM2, context.actorId]);
    }
    return { data: { siteId, name, clientId, inServiceFrom }, entityType: "client_site", entityId: siteId, topic: "client.site.created" };
  });
}

export async function editSite(pool: PoolLike, input: CommandInputMap["site.edit"], context: CommandContext) {
  return runPostgresCommand(pool, "site.edit", input, context, async (db) => {
    const site = await requireSite(db, context.organisationId, input.siteId, input.expectedVersion);
    // DATE comes back from pg as a JS Date; compare the normalised strings, so this fires in code.
    if (input.inServiceFrom !== null && site.vacatedEffective !== null && input.inServiceFrom >= site.vacatedEffective) {
      throw invalid("inServiceFrom", "INVALID_RANGE", `The in-service date must be before the vacated effective date (${ddmmyyyy(site.vacatedEffective)}).`);
    }
    const name = input.name.trim();
    await assertNameFree(db, context.organisationId, site.client_id, name, input.siteId);
    let version: number;
    try {
      version = await bumpVersion(db, context.organisationId, input.siteId, input.expectedVersion, "name=$4,in_service_from=$5", [name, input.inServiceFrom]);
    } catch (error) {
      throw uniqueViolation(error) ?? error;
    }
    return { data: { siteId: input.siteId, version, name, inServiceFrom: input.inServiceFrom }, entityType: "client_site", entityId: input.siteId, topic: "client.site.updated" };
  });
}

/** One registered office per client: setting it moves it; a vacated site cannot hold it. */
export async function setRegisteredOffice(pool: PoolLike, input: CommandInputMap["site.registeredOffice"], context: CommandContext) {
  return runPostgresCommand(pool, "site.registeredOffice", input, context, async (db) => {
    const site = await requireSite(db, context.organisationId, input.siteId, input.expectedVersion);
    if (input.isRegisteredOffice) {
      if (site.vacatedEffective !== null) throw invalid("isRegisteredOffice", "SITE_VACATED", "A vacated site — or one with a vacate date set — cannot be the registered office. Reinstate it first.");
      await db.query(`UPDATE nzi_console.client_sites SET is_registered_office=false,version=version+1 WHERE organisation_id=$1 AND client_id=$2 AND site_id<>$3 AND is_registered_office=true`, [context.organisationId, site.client_id, input.siteId]);
    }
    const version = await bumpVersion(db, context.organisationId, input.siteId, input.expectedVersion, "is_registered_office=$4", [input.isRegisteredOffice]);
    return { data: { siteId: input.siteId, version, isRegisteredOffice: input.isRegisteredOffice }, entityType: "client_site", entityId: input.siteId, topic: "client.site.registered_office_changed" };
  });
}

/** Vacating requires the effective date — the first day out of service. */
export async function vacateSite(pool: PoolLike, input: CommandInputMap["site.vacate"], context: CommandContext) {
  return runPostgresCommand(pool, "site.vacate", input, context, async (db) => {
    const site = await requireSite(db, context.organisationId, input.siteId, input.expectedVersion);
    if (site.is_registered_office) throw invalid("siteId", "REGISTERED_OFFICE", `${site.name} is the registered office. Mark another site as the registered office before vacating it.`);
    if (site.inServiceFrom !== null && input.effectiveDate <= site.inServiceFrom) {
      throw invalid("effectiveDate", "INVALID_RANGE", `The vacated effective date is the first day out of service, so it must be after the in-service date (${ddmmyyyy(site.inServiceFrom)}).`);
    }
    const version = await bumpVersion(db, context.organisationId, input.siteId, input.expectedVersion, "vacated_effective=$4", [input.effectiveDate]);
    return { data: { siteId: input.siteId, version, vacatedEffective: input.effectiveDate }, entityType: "client_site", entityId: input.siteId, topic: "client.site.vacated" };
  });
}

export async function reinstateSite(pool: PoolLike, input: CommandInputMap["site.reinstate"], context: CommandContext) {
  return runPostgresCommand(pool, "site.reinstate", input, context, async (db) => {
    const site = await requireSite(db, context.organisationId, input.siteId, input.expectedVersion);
    if (site.vacatedEffective === null) throw invalid("siteId", "NOT_VACATED", `${site.name} is not vacated.`);
    const version = await bumpVersion(db, context.organisationId, input.siteId, input.expectedVersion, "vacated_effective=NULL", []);
    return { data: { siteId: input.siteId, version }, entityType: "client_site", entityId: input.siteId, topic: "client.site.reinstated" };
  });
}

/** NZC-071 — append an effective-dated floor-area record; a correction is a new record, never an edit. */
export async function recordSiteFloorArea(pool: PoolLike, input: CommandInputMap["site.floorArea.record"], context: CommandContext) {
  return runPostgresCommand(pool, "site.floorArea.record", input, context, async (db) => {
    const site = await requireSite(db, context.organisationId, input.siteId, input.expectedVersion);
    if (input.effectiveFrom !== null && site.vacatedEffective !== null && input.effectiveFrom >= site.vacatedEffective) {
      throw invalid("effectiveFrom", "INVALID_RANGE", `A floor area cannot take effect once the site is vacated (${ddmmyyyy(site.vacatedEffective)}).`);
    }
    const floorAreaId = randomUUID();
    await db.query(`INSERT INTO nzi_console.client_site_floor_areas (organisation_id,floor_area_id,site_id,effective_from,floor_area_m2,recorded_by) VALUES ($1,$2,$3,$4,$5,$6)`, [context.organisationId, floorAreaId, input.siteId, input.effectiveFrom, input.floorAreaM2, context.actorId]);
    const version = await bumpVersion(db, context.organisationId, input.siteId, input.expectedVersion, "", []);
    return { data: { siteId: input.siteId, version, floorAreaId, floorAreaM2: input.floorAreaM2, effectiveFrom: input.effectiveFrom }, entityType: "client_site", entityId: input.siteId, topic: "client.site.floor_area_recorded" };
  });
}
