// Employee commuting (3.7) per-site sample uplift (BRIEF-commuting-uplift-lean). A job's per-site headcount (E, C), the uplift toggle
// and the headcount the client agreed are INPUTS held here; the uplift itself is derived (`computeSiteUplift`, contracts) from them and
// from the site's commuting rows, and is applied only to the figure that locks (the snapshot). The stored scope rows are never changed.
import {
  computeSiteUplift, type CommandContext, type CommandInputMap, type CommutingUpliftProvenance, type SiteUplift,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { CommandValidationError, requireCrpJob, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

export type SiteUpliftView = SiteUplift & {
  siteId: string;
  name: string;
  /** The held record's version (null: nothing entered yet). */
  version: number | null;
  agreedHeadcount: number | null;
  /** The site's sampled 3.7 figure, tCO₂e (as the rows stand), and the figure that locks (sampled × f when applied). */
  sampledTco2e: number;
  upliftedTco2e: number;
  /** Who last saved it and when (staff identity is not sent to the portal by its route). */
  savedBy: string | null;
  savedAt: string | null;
};
export type JobCommutingUplift = {
  jobId: string;
  sites: SiteUpliftView[];
  /** Live 3.7 rows with no site: left out of every site's R and of any uplift until the CRM assigns them. */
  unassignedRows: number;
};

type SiteRow = { site_id: string; name: string };
type HeadcountRow = { site_id: string; employees: number; company_car_users: number; uplift_enabled: boolean; agreed_uplift_headcount: number | null; version: number; updated_by: string; updated_at: Date | string };
export type CommutingRowFigure = { siteId: string | null; tco2e: number };

/**
 * The rows the uplift reads: enabled, not rejected, live 3.7 rows. (At the snapshot every enabled row is approved, so the
 * respondents the CRM saw while validating are the respondents that lock.)
 */
const COMMUTING_ROWS_SQL = `SELECT site_id, coalesce(override_tco2e, calculated_tco2e) AS tco2e
  FROM nzi_console.job_scope_rows
 WHERE organisation_id = $1 AND job_id = $2 AND scope = '3.7' AND origin = 'live' AND enabled AND review_status <> 'rejected'`;

/** A site's uplift from its rows and its held record. Pure over its inputs (the arithmetic is `computeSiteUplift`). */
export function upliftForSite(rows: readonly CommutingRowFigure[], siteId: string, held: Pick<HeadcountRow, "employees" | "company_car_users" | "uplift_enabled" | "agreed_uplift_headcount"> | null) {
  const mine = rows.filter((row) => row.siteId === siteId);
  const uplift = computeSiteUplift({
    employees: held ? held.employees : null, companyCarUsers: held ? held.company_car_users : null, respondents: mine.length,
    enabled: held ? held.uplift_enabled : false, agreedHeadcount: held ? held.agreed_uplift_headcount : null,
  });
  const sampledTco2e = mine.reduce((sum, row) => sum + row.tco2e, 0);
  return { uplift, sampledTco2e };
}

/** The job's sites with their headcount, respondents, response rate, uplift and the figures it yields. */
export async function readJobCommutingUplift(db: Queryable, organisationId: string, jobId: string): Promise<JobCommutingUplift> {
  const { rows: sites } = await db.query<SiteRow>(
    `SELECT s.site_id, s.name FROM nzi_console.jobs j JOIN nzi_console.client_sites s ON (s.organisation_id, s.client_id) = (j.organisation_id, j.client_id) AND s.archived = false
      WHERE j.organisation_id = $1 AND j.job_id = $2 ORDER BY lower(s.name), s.site_id`, [organisationId, jobId]);
  const { rows: held } = await db.query<HeadcountRow>(
    `SELECT site_id, employees, company_car_users, uplift_enabled, agreed_uplift_headcount, version, updated_by, updated_at FROM nzi_console.job_site_headcount WHERE organisation_id = $1 AND job_id = $2`,
    [organisationId, jobId]);
  const { rows: rowFigures } = await db.query<{ site_id: string | null; tco2e: string | number | null }>(COMMUTING_ROWS_SQL, [organisationId, jobId]);
  const figures: CommutingRowFigure[] = rowFigures.map((row) => ({ siteId: row.site_id, tco2e: Number(row.tco2e ?? 0) }));
  return {
    jobId,
    unassignedRows: figures.filter((row) => row.siteId === null).length,
    sites: sites.map((site) => {
      const record = held.find((candidate) => candidate.site_id === site.site_id) ?? null;
      const { uplift, sampledTco2e } = upliftForSite(figures, site.site_id, record);
      return {
        ...uplift, siteId: site.site_id, name: site.name, version: record?.version ?? null, agreedHeadcount: record?.agreed_uplift_headcount ?? null,
        sampledTco2e, upliftedTco2e: uplift.applied ? sampledTco2e * uplift.factor : sampledTco2e,
        savedBy: record?.updated_by ?? null, savedAt: record ? new Date(record.updated_at).toISOString() : null,
      };
    }),
  };
}

export type SiteHeadcountResult = { jobId: string; siteId: string; version: number };

async function saveHeadcount(db: Queryable, input: CommandInputMap["job.site.headcount.set"], context: CommandContext, inPortal: boolean) {
  await requireCrpJob(db, context.organisationId, input.jobId);
  const { rows: [site] } = await db.query<{ site_id: string }>(
    `SELECT s.site_id FROM nzi_console.jobs j JOIN nzi_console.client_sites s ON (s.organisation_id, s.client_id) = (j.organisation_id, j.client_id)
      WHERE j.organisation_id = $1 AND j.job_id = $2 AND s.site_id = $3 AND s.archived = false`, [context.organisationId, input.jobId, input.siteId]);
  if (!site) throw new CommandValidationError([{ field: "siteId", code: "NOT_FOUND", message: "That site is not one of this job's client's." }]);
  const { rows: [current] } = await db.query<{ version: number; employees: number; company_car_users: number; uplift_enabled: boolean; agreed_uplift_headcount: number | null }>(
    `SELECT version, employees, company_car_users, uplift_enabled, agreed_uplift_headcount FROM nzi_console.job_site_headcount WHERE organisation_id = $1 AND job_id = $2 AND site_id = $3 FOR UPDATE`,
    [context.organisationId, input.jobId, input.siteId]);
  const expected = input.expectedVersion ?? null;
  if (current ? expected !== current.version : expected !== null) throw new VersionConflictError(expected ?? 0, current?.version ?? 0);
  if (current && current.employees === input.employees && current.company_car_users === input.companyCarUsers && current.uplift_enabled === input.upliftEnabled && current.agreed_uplift_headcount === input.agreedHeadcount) {
    throw new CommandValidationError([{ field: "employees", code: "UNCHANGED", message: "Those figures are already held." }]);
  }
  const { rows: [saved] } = await db.query<{ version: number }>(
    `INSERT INTO nzi_console.job_site_headcount (organisation_id, job_id, site_id, employees, company_car_users, uplift_enabled, agreed_uplift_headcount, saved_in_portal, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (organisation_id, job_id, site_id) DO UPDATE SET employees = EXCLUDED.employees, company_car_users = EXCLUDED.company_car_users,
       uplift_enabled = EXCLUDED.uplift_enabled, agreed_uplift_headcount = EXCLUDED.agreed_uplift_headcount, saved_in_portal = EXCLUDED.saved_in_portal,
       version = job_site_headcount.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING version`,
    [context.organisationId, input.jobId, input.siteId, input.employees, input.companyCarUsers, input.upliftEnabled, input.agreedHeadcount, inPortal, context.actorId]);
  return {
    data: { jobId: input.jobId, siteId: input.siteId, version: saved!.version } as SiteHeadcountResult,
    entityType: "job_site_headcount", entityId: `${input.jobId}:${input.siteId}`,
    ...(current ? { before: { employees: current.employees, companyCarUsers: current.company_car_users, upliftEnabled: current.uplift_enabled, agreedHeadcount: current.agreed_uplift_headcount } } : {}),
  };
}

/** The CRM sets or confirms a site's headcount and uplift choice (scoperow.edit, versioned, audited). */
export function setJobSiteHeadcount(pool: PoolLike, input: CommandInputMap["job.site.headcount.set"], context: CommandContext): Promise<StoredOutcome<SiteHeadcountResult>> {
  return runPostgresCommand(pool, "job.site.headcount.set", input, context, async (db) => ({ ...(await saveHeadcount(db, input, context, false)), topic: "job.site.headcount.set" }));
}

/** The client enters the same record in the portal (portal.dataentry): same validation, same versioning, marked as the client's. */
export function savePortalSiteHeadcount(pool: PoolLike, input: CommandInputMap["portal.site.headcount.save"], context: CommandContext): Promise<StoredOutcome<SiteHeadcountResult>> {
  return runPostgresCommand(pool, "portal.site.headcount.save", input, context, async (db) => ({ ...(await saveHeadcount(db, input, context, true)), topic: "portal.site.headcount.saved" }));
}

/**
 * The uplift the snapshot applies: per site with the toggle on and something to scale, its factor, and the provenance to record.
 * `rows` are the rows being frozen (enabled, in the reporting boundary, approved) - a row with no site is never in any site's R and
 * is never scaled. Returns an empty map when no site is uplifted, so a snapshot without uplift is built exactly as before.
 */
export async function snapshotCommutingUplift(db: Queryable, organisationId: string, jobId: string, rows: ReadonlyArray<{ scope: string; site_id: string | null; site_label?: string | null; override_tco2e: unknown; calculated_tco2e: unknown }>) {
  const figures: CommutingRowFigure[] = rows.filter((row) => row.scope === "3.7").map((row) => ({ siteId: row.site_id, tco2e: Number(row.override_tco2e ?? row.calculated_tco2e) }));
  const { rows: held } = await db.query<HeadcountRow>(
    `SELECT site_id, employees, company_car_users, uplift_enabled, agreed_uplift_headcount, version, updated_by, updated_at FROM nzi_console.job_site_headcount WHERE organisation_id = $1 AND job_id = $2 AND uplift_enabled ORDER BY site_id`,
    [organisationId, jobId]);
  const bySite = new Map<string, SiteUplift>();
  const provenance: CommutingUpliftProvenance[] = [];
  for (const record of held) {
    const { uplift } = upliftForSite(figures, record.site_id, record);
    if (!uplift.applied || uplift.eligible === null || uplift.headcount === null) continue;
    bySite.set(record.site_id, uplift);
    provenance.push({
      siteId: record.site_id, siteLabel: rows.find((row) => row.site_id === record.site_id)?.site_label ?? null, employees: uplift.employees ?? 0, companyCarUsers: uplift.companyCarUsers,
      respondents: uplift.respondents, eligible: uplift.eligible, responseRate: uplift.responseRate, headcount: uplift.headcount, factor: uplift.factor,
      agreedBy: record.updated_by, agreedAt: new Date(record.updated_at).toISOString(),
    });
  }
  return { bySite, provenance };
}
