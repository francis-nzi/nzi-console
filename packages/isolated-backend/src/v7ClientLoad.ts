import { randomUUID } from "node:crypto";
import type { CommandContext } from "@nzi/contracts";
import { CLIENT_CONTACT_COLUMNS, recordContactVersion, sealContact, type ClientContactRow } from "./clientContactRecords";
import { openLegacyReport, sealLegacyReport, type LegacyReportParticulars } from "./legacyReportSeal";
import type { SealingKeys } from "./piiSealing";
import { resolveSealingKeys } from "./piiSealingKeys";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { IMPORT_ACTOR, SOURCE_SYSTEM, type ClientImportPlan, type PlannedClient, type PlannedJob } from "./v7ClientImport";

/**
 * Write a v7 client-and-job plan (docs/CLIENT_JOB_IMPORT_DESIGN.md §8). In foreign-key order — client → sites →
 * contacts → target → jobs → migrated rows → legacy report versions — as the application role, inside the target
 * organisation, so row-level security, every constraint and 0133/0135's triggers apply exactly as they do to any
 * other writer.
 *
 * **One transaction per client**: a failure leaves whole clients or nothing, and the others go ahead.
 *
 * **A dry run is the load, rolled back.** Every insert, constraint, trigger, seal and job-number clash is exercised,
 * and nothing is kept. `commit: true` is the only difference.
 *
 * **Reconcile by reading.** Each record is found by `(organisation, source_system, legacy_db_id)`: absent → inserted;
 * present and identical in every column the import writes → left alone; **present and different → that client is
 * refused**, naming the table, the record and the columns. History is immutable, so a difference means v7 changed
 * after migration, or the record was edited here since — either way a person decides. Nothing is ever deleted.
 */

export class V7ClientLoadRefused extends Error {}
class DryRunRollback extends Error {}

export type ClientOutcome = {
  clientId: string; legacyId: string;
  state: "loaded" | "unchanged" | "refused";
  inserted: Record<Kind, number>; unchanged: Record<Kind, number>;
  refusal?: string;
};
type Kind = "clients" | "sites" | "contacts" | "targets" | "jobs" | "rows" | "reports";
const KINDS: Kind[] = ["clients", "sites", "contacts", "targets", "jobs", "rows", "reports"];

export type LoadOutcome = {
  committed: boolean; runId: string;
  clients: ClientOutcome[];
  /** Where the job-number counter stands afterwards (decision 1a), when committed. */
  counterAt: number | null;
};

export type LoadOptions = { commit: boolean; runId?: string; keys?: SealingKeys };

type Col = { column: string; value: unknown; type: string; compare?: boolean };

/** The columns that differ between what is stored and what the plan would write, compared by Postgres itself. */
async function differs(db: Queryable, table: string, where: string, whereParams: unknown[], cols: readonly Col[]): Promise<string[] | null> {
  const compared = cols.filter((col) => col.compare !== false);
  const params = [...whereParams, ...compared.map((col) => serialise(col))];
  const checks = compared.map((col, index) =>
    `CASE WHEN ${col.column} IS DISTINCT FROM $${whereParams.length + index + 1}::${col.type} THEN '${col.column}' END`);
  const { rows } = await db.query<{ differs: string[] }>(
    `SELECT array_remove(ARRAY[${checks.join(",") || "NULL::text"}]::text[], NULL) AS differs FROM nzi_console.${table} WHERE ${where}`, params);
  return rows[0] ? rows[0].differs : null;
}

const serialise = (col: Col): unknown =>
  col.value === null || col.value === undefined ? null
    : col.type === "jsonb" ? JSON.stringify(col.value)
      : typeof col.value === "number" ? String(col.value) : col.value;

async function insert(db: Queryable, table: string, cols: readonly Col[]): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.${table} (${cols.map((col) => col.column).join(",")}) VALUES (${cols.map((col, index) => `$${index + 1}::${col.type}`).join(",")})`,
    cols.map(serialise));
}

/** Absent → insert; identical → unchanged; different → refused. The identity is the import key. */
async function reconcile(db: Queryable, table: string, organisationId: string, legacyDbId: string, cols: readonly Col[], what: string):
  Promise<"inserted" | "unchanged"> {
  const found = await differs(db, table, "organisation_id=$1 AND source_system=$2 AND legacy_db_id=$3", [organisationId, SOURCE_SYSTEM, legacyDbId], cols);
  if (found === null) {
    await insert(db, table, [
      { column: "organisation_id", value: organisationId, type: "text" },
      { column: "source_system", value: SOURCE_SYSTEM, type: "text" },
      { column: "legacy_db_id", value: legacyDbId, type: "text" },
      ...cols,
    ]);
    return "inserted";
  }
  if (found.length > 0) {
    throw new V7ClientLoadRefused(`${what} is already loaded and differs in ${found.join(", ")}: v7 changed after migration, or it was edited here since. Nothing of this client was written.`);
  }
  return "unchanged";
}

export async function loadV7ClientPlan(pool: PoolLike, plan: ClientImportPlan, options: LoadOptions): Promise<LoadOutcome> {
  if (plan.refusals.length > 0) {
    throw new V7ClientLoadRefused(`The plan carries ${plan.refusals.length} refusal(s): ${plan.refusals.map((finding) => finding.code).join(", ")}. Nothing was written.`);
  }
  const keys = options.keys ?? resolveSealingKeys();
  const runId = options.runId ?? `v7-import-${randomUUID()}`;
  const outcome: LoadOutcome = { committed: options.commit, runId, clients: [], counterAt: null };

  for (const client of plan.clients) {
    const counts = { inserted: zero(), unchanged: zero() };
    try {
      await withTenantWrite(pool, plan.organisationId, async (db) => {
        await loadClient(db, plan, client, counts, { runId, keys });
        if (!options.commit) throw new DryRunRollback();
      });
      outcome.clients.push(result(client, counts, "loaded"));
    } catch (error) {
      if (error instanceof DryRunRollback) { outcome.clients.push(result(client, counts, "loaded")); continue; }
      outcome.clients.push({ ...result(client, counts, "refused"), refusal: explain(error, client) });
    }
  }

  if (options.commit && outcome.clients.some((entry) => entry.inserted.jobs > 0)) {
    // Decision 1a: new jobs continue after the highest number that now exists, v7's included.
    outcome.counterAt = await withTenantWrite(pool, plan.organisationId, async (db) =>
      (await db.query<{ n: number }>(`SELECT nzi_console.advance_job_sequence_past_existing() AS n`)).rows[0]!.n);
  }
  return outcome;
}

const zero = (): Record<Kind, number> => Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<Kind, number>;
function result(client: PlannedClient, counts: { inserted: Record<Kind, number>; unchanged: Record<Kind, number> }, state: "loaded" | "refused"): ClientOutcome {
  const anyInserted = KINDS.some((kind) => counts.inserted[kind] > 0);
  return {
    clientId: client.clientId, legacyId: client.legacyId,
    state: state === "refused" ? "refused" : anyInserted ? "loaded" : "unchanged",
    inserted: state === "refused" ? zero() : counts.inserted, unchanged: state === "refused" ? zero() : counts.unchanged,
  };
}

function explain(error: unknown, client: PlannedClient): string {
  if (error instanceof V7ClientLoadRefused) return error.message;
  const pgError = error as { code?: string; constraint?: string; detail?: string; message?: string };
  if (pgError.code === "23505" && pgError.constraint === "jobs_sequence_key") {
    return `A job number of ${client.clientId} is already held by another job (${pgError.detail ?? "sequence clash"}). ` +
      "Decision 1a: retire the demo-organisation clash first. Nothing of this client was written.";
  }
  if (pgError.code === "23505") return `${pgError.constraint ?? "a unique key"} refused a row of ${client.clientId} (${pgError.detail ?? ""}). Nothing of this client was written.`;
  return `${client.clientId} could not be loaded: ${pgError.message ?? String(error)}. Nothing of this client was written.`;
}

async function loadClient(
  db: Queryable, plan: ClientImportPlan, client: PlannedClient,
  counts: { inserted: Record<Kind, number>; unchanged: Record<Kind, number> },
  run: { runId: string; keys: SealingKeys },
): Promise<void> {
  const org = plan.organisationId;
  const tally = (kind: Kind, state: "inserted" | "unchanged") => { counts[state][kind] += 1; };
  const f = client.fields;

  // ── The client ──
  tally("clients", await reconcile(db, "clients", org, client.legacyId, [
    { column: "client_id", value: client.clientId, type: "text" },
    { column: "name", value: f.name, type: "text" },
    { column: "status", value: f.status, type: "text" },
    { column: "sector", value: f.sector, type: "text" },
    { column: "website", value: f.website, type: "text" },
    { column: "company_registration", value: f.companyRegistration, type: "text" },
    { column: "headquarters", value: f.headquarters, type: "text" },
    { column: "financial_year_end_month", value: f.financialYearEndMonth, type: "integer" },
    { column: "currency", value: f.currency, type: "text" },
    { column: "company_description", value: f.companyDescription, type: "text" },
    { column: "portfolio", value: f.portfolio, type: "text" },
    { column: "referral", value: f.referral, type: "text" },
    { column: "owner_name", value: f.ownerName, type: "text" },
    { column: "client_manager", value: f.clientManager, type: "text" },
    { column: "registered_address_line1", value: f.registeredAddressLine1, type: "text" },
    { column: "registered_address_line2", value: f.registeredAddressLine2, type: "text" },
    { column: "registered_city", value: f.registeredCity, type: "text" },
    { column: "registered_region", value: f.registeredRegion, type: "text" },
    { column: "registered_postcode", value: f.registeredPostcode, type: "text" },
    { column: "registered_country", value: f.registeredCountry, type: "text" },
    { column: "net_zero_target_year", value: f.netZeroTargetYear, type: "integer" },
    { column: "scope1_interim_year", value: f.interim.scope1Pct === null ? null : f.interim.year, type: "integer" },
    { column: "scope1_interim_reduction_pct", value: f.interim.year === null ? null : f.interim.scope1Pct, type: "numeric" },
    { column: "scope2_interim_year", value: f.interim.scope2Pct === null ? null : f.interim.year, type: "integer" },
    { column: "scope2_interim_reduction_pct", value: f.interim.year === null ? null : f.interim.scope2Pct, type: "numeric" },
    { column: "scope3_interim_year", value: f.interim.scope3Pct === null ? null : f.interim.year, type: "integer" },
    { column: "scope3_interim_reduction_pct", value: f.interim.year === null ? null : f.interim.scope3Pct, type: "numeric" },
    { column: "baseline_period_start", value: f.baseline.periodStart, type: "date" },
    { column: "baseline_period_end", value: f.baseline.periodEnd, type: "date" },
    { column: "baseline_scope1_tco2e", value: f.baseline.scope1, type: "numeric" },
    { column: "baseline_scope2_tco2e", value: f.baseline.scope2, type: "numeric" },
    { column: "baseline_scope3_tco2e", value: f.baseline.scope3, type: "numeric" },
    { column: "baseline_total_tco2e", value: f.baseline.total, type: "numeric" },
  ], `client ${client.clientId}`));

  // ── Sites ──
  for (const site of client.sites) {
    tally("sites", await reconcile(db, "client_sites", org, site.legacyId, [
      { column: "site_id", value: site.siteId, type: "text" },
      { column: "client_id", value: client.clientId, type: "text" },
      { column: "name", value: site.name, type: "text" },
      { column: "created_by", value: IMPORT_ACTOR, type: "text" },
      { column: "address_lines_json", value: site.addressLines, type: "jsonb" },
      { column: "latitude", value: site.latitude, type: "numeric" },
      { column: "longitude", value: site.longitude, type: "numeric" },
      { column: "archived", value: site.archived, type: "boolean" },
      { column: "is_registered_office", value: site.isRegisteredOffice, type: "boolean" },
      { column: "vacated_effective", value: site.vacatedEffective, type: "date" },
    ], `site ${site.siteId}`));
  }

  // ── Contacts: plaintext, then its version and its seal, in this transaction (NZC-119) ──
  const context = {
    organisationId: org, actorId: IMPORT_ACTOR, principal: "staff", idempotencyKey: run.runId, correlationId: run.runId,
  } as unknown as CommandContext;
  for (const contact of client.contacts) {
    const state = await reconcile(db, "client_contacts", org, contact.legacyId, [
      { column: "contact_id", value: contact.contactId, type: "text" },
      { column: "client_id", value: client.clientId, type: "text" },
      { column: "full_name", value: contact.fullName, type: "text" },
      { column: "job_title", value: contact.jobTitle, type: "text" },
      { column: "email", value: contact.email, type: "text" },
      { column: "phone", value: contact.phone, type: "text" },
      { column: "is_primary", value: contact.isPrimary, type: "boolean" },
      { column: "status", value: "active", type: "text" },
      { column: "created_by", value: IMPORT_ACTOR, type: "text", compare: false },
      { column: "updated_by", value: IMPORT_ACTOR, type: "text", compare: false },
    ], `contact ${contact.contactId}`);
    if (state === "inserted") {
      const row = (await db.query<ClientContactRow>(
        `SELECT ${CLIENT_CONTACT_COLUMNS} FROM nzi_console.client_contacts WHERE organisation_id=$1 AND contact_id=$2`, [org, contact.contactId])).rows[0]!;
      await recordContactVersion(db, context, row);
      await sealContact(db, context, row);
    }
    tally("contacts", state);
  }

  // ── The target record, version 1, as v7 held it ──
  if (client.target) {
    const t = client.target;
    const cols: Col[] = [
      { column: "benchmark_year", value: t.benchmarkYear, type: "integer" },
      { column: "benchmark_total_tco2e", value: t.benchmarkTotal, type: "numeric" },
      { column: "benchmark_scope1_tco2e", value: t.benchmarkScope1, type: "numeric" },
      { column: "benchmark_scope2_tco2e", value: t.benchmarkScope2, type: "numeric" },
      { column: "benchmark_scope3_tco2e", value: t.benchmarkScope3, type: "numeric" },
      { column: "scope1_year", value: t.scope1?.year ?? null, type: "integer" }, { column: "scope1_pct", value: t.scope1?.pct ?? null, type: "numeric" },
      { column: "scope2_year", value: t.scope2?.year ?? null, type: "integer" }, { column: "scope2_pct", value: t.scope2?.pct ?? null, type: "numeric" },
      { column: "scope3_year", value: t.scope3?.year ?? null, type: "integer" }, { column: "scope3_pct", value: t.scope3?.pct ?? null, type: "numeric" },
      { column: "benchmark_source", value: "client-record", type: "text" },
    ];
    const found = await differs(db, "client_targets", "organisation_id=$1 AND client_id=$2 AND version=1", [org, client.clientId], cols);
    if (found === null) {
      await insert(db, "client_targets", [
        { column: "organisation_id", value: org, type: "text" }, { column: "client_id", value: client.clientId, type: "text" },
        { column: "version", value: 1, type: "integer" }, ...cols,
        { column: "set_by", value: IMPORT_ACTOR, type: "text" }, { column: "correlation_id", value: run.runId, type: "text" },
      ]);
      tally("targets", "inserted");
    } else if (found.length > 0) {
      throw new V7ClientLoadRefused(`the target record of ${client.clientId} (version 1) differs in ${found.join(", ")}. Nothing of this client was written.`);
    } else tally("targets", "unchanged");
  }

  // ── Jobs, and under each its migrated rows and legacy report versions ──
  for (const job of client.jobs) {
    const jobState = await reconcile(db, "jobs", org, job.legacyId, jobCols(client, job), `job ${job.jobId} (${job.legacyJobNumber})`);
    tally("jobs", jobState);
    if (job.family === "crp" && job.periodStart && job.periodEnd) {
      const config = await db.query(`SELECT 1 FROM nzi_console.job_emissions_config WHERE organisation_id=$1 AND job_id=$2`, [org, job.jobId]);
      if (config.rows.length === 0) {
        await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`,
          [org, job.jobId, job.periodStart, job.periodEnd]);
      }
    }
    let rowsInserted = 0;
    for (const row of job.rows) {
      const state = await reconcile(db, "job_scope_rows", org, row.legacyDbId, [
        { column: "scope_row_id", value: row.scopeRowId, type: "text" },
        { column: "job_id", value: job.jobId, type: "text" },
        { column: "scope", value: row.scope, type: "text" },
        { column: "source_label", value: row.sourceLabel, type: "text" },
        { column: "report_label", value: row.reportLabel, type: "text" },
        { column: "level_1", value: row.level1, type: "text" }, { column: "level_2", value: row.level2, type: "text" },
        { column: "level_3", value: row.level3, type: "text" }, { column: "level_4", value: row.level4, type: "text" },
        { column: "column_text", value: row.columnText, type: "text" },
        { column: "quantity", value: row.quantity, type: "numeric" }, { column: "unit", value: row.unit, type: "text" },
        { column: "dataset_id", value: row.datasetId, type: "text" }, { column: "factor_id", value: row.factorId, type: "text" },
        { column: "calculated_tco2e", value: row.calculatedTco2e, type: "numeric" },
        { column: "review_status", value: row.reviewStatus, type: "text" },
        // Carried from v7 (decision 7): the import is the act of record, never a console reviewer.
        { column: "reviewed_row_version", value: row.reviewStatus === "pending" ? null : 1, type: "integer", compare: false },
        { column: "reviewed_by", value: row.reviewStatus === "pending" ? null : IMPORT_ACTOR, type: "text", compare: false },
        { column: "reviewed_at", value: row.reviewStatus === "pending" ? null : new Date().toISOString(), type: "timestamptz", compare: false },
        { column: "reviewer_note", value: row.reviewStatus === "rejected" ? "Rejected in v7; carried by the import." : null, type: "text", compare: false },
        { column: "enabled", value: row.enabled, type: "boolean" },
        { column: "apply_pct", value: row.applyPct, type: "numeric" },
        { column: "data_confidence", value: row.dataConfidence, type: "text" },
        { column: "site_id", value: row.siteId, type: "text" },
        { column: "is_auto_generated", value: row.isAutoGenerated, type: "boolean" },
        { column: "auto_pair_kind", value: row.autoPairKind, type: "text" },
        { column: "linked_row_id", value: row.linkedRowId, type: "text" },
        { column: "provenance_json", value: row.provenance, type: "jsonb" },
        { column: "lineage_json", value: row.lineage, type: "jsonb" },
        { column: "origin", value: "migrated", type: "text" },
        { column: "migrated_record", value: row.migratedRecord, type: "jsonb" },
      ], `row ${row.scopeRowId} of ${job.legacyJobNumber}`);
      tally("rows", state);
      if (state === "inserted") rowsInserted += 1;
    }
    let reportsInserted = 0;
    for (const report of job.reports) {
      const cols: Col[] = [
        { column: "legacy_report_id", value: report.legacyReportId, type: "text" },
        { column: "job_id", value: job.jobId, type: "text" },
        { column: "kind", value: report.kind, type: "text" },
        { column: "version_number", value: report.versionNumber, type: "integer" },
        { column: "legacy_status", value: report.legacyStatus, type: "text" },
        { column: "report_format", value: report.reportFormat, type: "text" },
        { column: "is_portal_version", value: report.isPortalVersion, type: "boolean" },
        { column: "storage_provider", value: report.storageProvider, type: "text" },
        { column: "generated_at", value: report.generatedAt, type: "timestamptz" },
        { column: "reviewed_at", value: report.reviewedAt, type: "timestamptz" },
        { column: "finalized_at", value: report.finalizedAt, type: "timestamptz" },
        { column: "superseded_at", value: report.supersededAt, type: "timestamptz" },
        { column: "v7_data_hash", value: report.v7DataHash, type: "text" },
      ];
      const found = await differs(db, "legacy_report_versions", "organisation_id=$1 AND source_system=$2 AND kind=$3 AND legacy_db_id=$4",
        [org, SOURCE_SYSTEM, report.kind, report.legacyDbId], cols);
      const sealed = found === null ? sealLegacyReport({ payloadText: report.payloadText, v7DataHash: report.v7DataHash, particulars: report.particulars }, run.keys.masterKey) : null;
      if (found === null) {
        await insert(db, "legacy_report_versions", [
          { column: "organisation_id", value: org, type: "text" },
          { column: "source_system", value: SOURCE_SYSTEM, type: "text" },
          { column: "legacy_db_id", value: report.legacyDbId, type: "text" },
          ...cols,
          { column: "payload_sha256", value: sealed!.payloadSha256, type: "text" },
          { column: "payload_sealed", value: sealed!.payloadSealed, type: "jsonb" },
          { column: "particulars_sealed", value: sealed!.particularsSealed, type: "jsonb" },
          { column: "content_key_wrapped", value: sealed!.contentKeyWrapped, type: "jsonb" },
          { column: "imported_by", value: IMPORT_ACTOR, type: "text" },
        ]);
        tally("reports", "inserted");
        reportsInserted += 1;
        continue;
      }
      if (found.length > 0) throw new V7ClientLoadRefused(`report ${report.legacyReportId} of ${job.legacyJobNumber} is already loaded and differs in ${found.join(", ")}. Nothing of this client was written.`);
      // The sealed half is compared opened: the payload by its digest, the particulars field by field.
      const stored = (await db.query<{ payload_sealed: never; payload_sha256: string | null; particulars_sealed: never; content_key_wrapped: never }>(
        `SELECT payload_sealed, payload_sha256, particulars_sealed, content_key_wrapped FROM nzi_console.legacy_report_versions
          WHERE organisation_id=$1 AND source_system=$2 AND kind=$3 AND legacy_db_id=$4`, [org, SOURCE_SYSTEM, report.kind, report.legacyDbId])).rows[0]!;
      let opened: ReturnType<typeof openLegacyReport>;
      try {
        opened = openLegacyReport(stored, run.keys.masterKey);
      } catch (error) {
        throw new V7ClientLoadRefused(`report ${report.legacyReportId} of ${job.legacyJobNumber} is already loaded and could not be opened to compare ` +
          `(${error instanceof Error ? error.message : String(error)}) — is NZI_SUBJECT_MASTER_KEY the one it was loaded under? Nothing of this client was written.`);
      }
      if (opened.payloadText !== report.payloadText || !sameParticulars(opened.particulars, report.particulars)) {
        throw new V7ClientLoadRefused(`report ${report.legacyReportId} of ${job.legacyJobNumber} is already loaded with a different snapshot or particulars. Nothing of this client was written.`);
      }
      tally("reports", "unchanged");
    }
    if (jobState === "inserted" || rowsInserted > 0 || reportsInserted > 0) {
      await audit(db, org, run.runId, "job.imported", "job", job.jobId, client.clientId, plan.extractSha256, {
        legacyJobNumber: job.legacyJobNumber, family: job.family, rowsInserted, reportsInserted,
        published: job.reconciliation.published?.legacyReportId ?? null, reconciliationDifferences: job.reconciliation.differences.length,
      });
    }
  }

  if (KINDS.some((kind) => counts.inserted[kind] > 0)) {
    await audit(db, org, run.runId, "client.imported", "client", client.clientId, client.clientId, plan.extractSha256, {
      inserted: counts.inserted, unchanged: counts.unchanged,
    });
  }
}

const sameParticulars = (stored: LegacyReportParticulars | null, planned: LegacyReportParticulars): boolean =>
  JSON.stringify(sortKeys(stored ?? {})) === JSON.stringify(sortKeys(planned));
const sortKeys = (value: object) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)));

function jobCols(client: PlannedClient, job: PlannedJob): Col[] {
  return [
    { column: "job_id", value: job.jobId, type: "text" },
    { column: "client_id", value: client.clientId, type: "text" },
    { column: "sequence", value: job.sequence, type: "integer" },
    { column: "job_family", value: job.family, type: "text" },
    { column: "title", value: job.title, type: "text" },
    { column: "status", value: job.status, type: "text" },
    { column: "workflow_stage", value: job.workflowStage, type: "text" },
    { column: "reporting_year", value: job.reportingYear, type: "integer" },
    { column: "owner_name", value: job.ownerName, type: "text" },
    { column: "start_date", value: job.startDate, type: "date" },
    { column: "due_date", value: job.dueDate, type: "date" },
    { column: "reporting_period_start", value: job.periodStart, type: "date" },
    { column: "reporting_period_end", value: job.periodEnd, type: "date" },
    { column: "detail_json", value: job.detail, type: "jsonb" },
    { column: "legacy_job_number", value: job.legacyJobNumber, type: "text" },
    { column: "legacy_wfm_job_no", value: job.legacyWfmJobNo, type: "text" },
    ...(job.createdAt ? [{ column: "created_at", value: job.createdAt, type: "timestamptz" }] : []),
  ];
}

/** One audit event per imported client and per job: the run, the extract's hash and the counts — no personal data. */
async function audit(db: Queryable, org: string, runId: string, action: string, entityType: string, entityId: string,
  clientId: string, extractSha256: string, counts: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.audit_events (organisation_id,audit_event_id,actor_id,principal_type,action,entity_type,entity_id,correlation_id,reason,after_json,client_id)
     VALUES ($1,$2,$3,'system',$4,$5,$6,$7,$8,$9::jsonb,$10)`,
    [org, randomUUID(), IMPORT_ACTOR, action, entityType, entityId, runId,
      "Imported from NZ Insights Pro v7 (docs/CLIENT_JOB_IMPORT_DESIGN.md)",
      JSON.stringify({ run: runId, sourceSystem: SOURCE_SYSTEM, extractSha256, ...counts }), clientId]);
}
