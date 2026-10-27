import {
  importRowIssue,
  importRowStatus,
  reconcileSpendImport,
  spendImportLineIdentity,
  reviewSpendImportRow,
  spendImportRowKey,
  summariseImportReview,
  routeSpendLine,
  SPEND_RESIDUAL_CATEGORY,
  spendCategoryOf,
  type ImportRowReview,
  type SpendAllocationEntry,
  type SpendRouting,
  type SpendImportIdentity,
  type SpendImportPreflightState,
  type SpendImportRow,
} from "@nzi/contracts";
import { dateOnly } from "./dates";
import type { PoolLike, Queryable } from "./postgres";
import { withTenantRead } from "./postgres";
import { activeSpendAllocationsForJob } from "./spendAllocationReads";

export type SpendImportJobContext = {
  reportingFrom: string;
  reportingTo: string;
  categoryIds: Set<string>;
  factorIds: Set<string>;
  clientFactorIds: Set<string>;
  /**
   * D3 (R2): the job's live (non-voided) spend lines, counted by identity — description, net value, GL code and, for an imported
   * line, its invoice date (`spendImportLineIdentity`). Read before anything is written, so a re-import adds nothing it holds.
   */
  existingLines: Map<string, number>;
  /** D3 (R4): carried-forward lines still waiting for this year's figure, by carry key (GL code, else description). */
  carriedLines: Map<string, string[]>;
  /** D2: the client's live allocation map, which routes each line to its category. */
  allocations: SpendAllocationEntry[];
  /** D2: the scopes each selectable factor carries, so a line routed to a category its factor cannot price is held. */
  factorScopes: Map<string, string[]>;
  clientFactorScopes: Map<string, string>;
};

/**
 * Data entry D3 (R2): the window a spend import is pinned to — its identity, and the period its invoice dates must fall in. The
 * job's emissions window (kept in step with the job's period by job.update), else the job's own reporting period — its financial
 * year, whatever month it ends. **Never the calendar year:** a September year-end job given 1 Jan–31 Dec overlaps the next year's
 * job by three months, and the same ledger line imported into both is counted twice. A job with neither has no window, and
 * nothing is imported until its reporting period is set.
 */
export async function spendImportWindow(db: Queryable, organisationId: string, jobId: string): Promise<{ from: string; to: string } | null> {
  const { rows } = await db.query<{ reporting_from: Date | string | null; reporting_to: Date | string | null; period_start: Date | string | null; period_end: Date | string | null }>(
    `SELECT cfg.reporting_from,cfg.reporting_to,j.reporting_period_start AS period_start,j.reporting_period_end AS period_end
       FROM nzi_console.jobs j
       LEFT JOIN nzi_console.job_emissions_config cfg ON (cfg.organisation_id,cfg.job_id)=(j.organisation_id,j.job_id)
      WHERE j.organisation_id=$1 AND j.job_id=$2`,
    [organisationId, jobId],
  );
  const row = rows[0];
  if (!row) return null;
  // `date` columns, read as days: a shifted window silently accepts a row from the month before it.
  if (row.reporting_from && row.reporting_to) return { from: dateOnly(row.reporting_from), to: dateOnly(row.reporting_to) };
  if (row.period_start && row.period_end) return { from: dateOnly(row.period_start), to: dateOnly(row.period_end) };
  return null;
}

export async function loadSpendImportContext(db: Queryable, organisationId: string, jobId: string): Promise<SpendImportJobContext | null> {
  const window = await spendImportWindow(db, organisationId, jobId);
  if (!window) return null;
  const categories = await db.query<{ category_id: string }>(
    `SELECT c.category_id FROM nzi_console.purchased_goods_categories c JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(c.organisation_id,c.client_id) WHERE c.organisation_id=$1 AND j.job_id=$2`,
    [organisationId, jobId],
  );
  const factors = await db.query<{ factor_id: string; scopes: string[] }>(
    `SELECT f.factor_id, f.scopes FROM nzi_console.job_dataset_selections s JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id)=(s.organisation_id,s.dataset_id) WHERE s.organisation_id=$1 AND s.job_id=$2 AND f.active=true`,
    [organisationId, jobId],
  );
  const clientFactors = await db.query<{ client_factor_id: string; scope: string }>(
    `SELECT cf.client_factor_id, cf.scope FROM nzi_console.client_factors cf JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(cf.organisation_id,cf.client_id) WHERE cf.organisation_id=$1 AND j.job_id=$2 AND (cf.job_id IS NULL OR cf.job_id=j.job_id) AND cf.archived=false`,
    [organisationId, jobId],
  );
  // D3 (R2): read first. An imported line holds its invoice date in `asset_identifier` (the import writes it there); any other
  // line has no invoice date. A carried line still waiting for its figure is a slot, not a line the job holds.
  const existing = await db.query<{ source_id: string; source_name: string; quantity: string | null; source_subtype: string | null; invoice_date: string | null; carry_key: string | null }>(
    `SELECT source_id,source_name,quantity,source_subtype,CASE WHEN import_batch_id IS NOT NULL THEN asset_identifier END AS invoice_date,carry_key
       FROM nzi_console.job_emission_sources
      WHERE organisation_id=$1 AND job_id=$2 AND source_type='spend' AND voided_at IS NULL
      ORDER BY created_at,source_id`,
    [organisationId, jobId],
  );
  const existingLines = new Map<string, number>();
  const carriedLines = new Map<string, string[]>();
  for (const r of existing.rows) {
    if (r.carry_key && r.quantity === null) { carriedLines.set(r.carry_key, [...(carriedLines.get(r.carry_key) ?? []), r.source_id]); continue; }
    const identity = spendImportLineIdentity({ description: r.source_name, netValue: r.quantity == null ? null : Number(r.quantity), glCode: r.source_subtype, invoiceDate: r.invoice_date });
    existingLines.set(identity, (existingLines.get(identity) ?? 0) + 1);
  }
  return {
    reportingFrom: window.from,
    reportingTo: window.to,
    categoryIds: new Set(categories.rows.map((r) => r.category_id)),
    factorIds: new Set(factors.rows.map((r) => r.factor_id)),
    clientFactorIds: new Set(clientFactors.rows.map((r) => r.client_factor_id)),
    allocations: await activeSpendAllocationsForJob(db, organisationId, jobId),
    factorScopes: factors.rows.reduce((map, r) => map.set(r.factor_id, [...(map.get(r.factor_id) ?? []), ...r.scopes]), new Map<string, string[]>()),
    clientFactorScopes: new Map(clientFactors.rows.map((r) => [r.client_factor_id, r.scope])),
    existingLines,
    carriedLines,
  };
}

/**
 * D2 (R2): a line as it will be filed — routed by the client's map (its GL code, else its description; else the PG&S residual),
 * priced with its own factor or, where it names none, the map entry's default spend factor. A PG&S sub-category travels only with a
 * line filed in PG&S; VAT only with a line whose category takes it (R6).
 */
export function routedImportRow(row: SpendImportRow, allocations: readonly SpendAllocationEntry[]): { row: SpendImportRow; routing: SpendRouting } {
  const routing = routeSpendLine(allocations, { glCode: row.glCode, description: row.description });
  const useDefault = row.factorId === null && row.clientFactorId === null && routing.defaultFactorId !== null;
  return {
    routing,
    row: {
      ...row,
      purchasedGoodsCategoryId: routing.categoryCode === SPEND_RESIDUAL_CATEGORY ? row.purchasedGoodsCategoryId : null,
      vatPercent: routing.vatApplies ? row.vatPercent : null,
      ...(useDefault ? { factorSource: "dataset" as const, factorId: routing.defaultFactorId, datasetId: routing.defaultDatasetId, clientFactorId: null } : {}),
    },
  };
}

/**
 * Server-authoritative row review — file-local + job context, on each line as D2 routes it — then D3's reconciliation (R2, R4),
 * read from the job before anything is written: a line the job already holds is said (ALREADY_IMPORTED) and will not be imported
 * again; a line whose GL code a carried-forward line holds fills that line. Blocked lines are not reconciled.
 */
export function reviewSpendImportRows(rows: SpendImportRow[], context: SpendImportJobContext): ImportRowReview[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = spendImportRowKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const reviews = rows.map((original) => {
    const key = spendImportRowKey(original);
    const { row, routing } = routedImportRow(original, context.allocations);
    const review: ImportRowReview = { ...reviewSpendImportRow(row, context, (counts.get(key) ?? 0) > 1, routing.categoryCode === SPEND_RESIDUAL_CATEGORY), routing };
    const root = spendCategoryOf(routing.categoryCode)?.scope ?? "3";
    const scopes = row.factorSource === "client" ? [context.clientFactorScopes.get(row.clientFactorId ?? "") ?? ""] : context.factorScopes.get(row.factorId ?? "") ?? [];
    if (!review.issues.some((issue) => issue.code === "FACTOR_UNRESOLVED") && !scopes.some((tag) => tag.split(".")[0] === root)) {
      review.issues.push(importRowIssue("FACTOR_NOT_IN_CATEGORY", `This line is filed in Scope ${root}, and its factor is not a Scope ${root} factor. Choose a spend factor for that category, or move the line.`));
    }
    if (!routing.vatApplies && original.vatPercent !== null && original.vatPercent > 0) {
      review.issues.push(importRowIssue("VAT_NOT_APPLICABLE", "VAT does not apply to this line's category, so its VAT % is not recorded."));
    }
    review.status = importRowStatus(review.issues);
    return review;
  });
  const reconciled = reconcileSpendImport(rows.map((row, index) => ({ ...row, skip: reviews[index]!.status === "blocked" })), context.existingLines, context.carriedLines);
  return reviews.map((review, index) => {
    const reconciliation = reconciled[index];
    if (!reconciliation) return review;
    if (reconciliation.kind === "already-imported") {
      review.issues.push(importRowIssue("ALREADY_IMPORTED", "This job already has this line — the same description, net value, GL code and invoice date — so it is not imported again."));
      review.status = importRowStatus(review.issues);
    }
    return { ...review, reconciliation };
  });
}

export type SpendImportPreflight =
  | { kind: "blocked"; reason: "wrong-period" | "stale-template"; message: string }
  | { kind: "preview"; identity: SpendImportIdentity; reviews: ImportRowReview[]; summary: ReturnType<typeof summariseImportReview> };

/** Compare a verified token's identity to the job's current state and review the rows. */
export async function previewSpendImport(
  pool: PoolLike,
  organisationId: string,
  identity: SpendImportIdentity,
  rows: SpendImportRow[],
  templateVersion: number,
): Promise<SpendImportPreflight | { kind: "blocked"; reason: "job-not-found"; message: string }> {
  return withTenantRead(pool, organisationId, async (db) => {
    const context = await loadSpendImportContext(db, organisationId, identity.jobId);
    if (!context) return { kind: "blocked" as const, reason: "job-not-found" as const, message: "The job or its reporting period is not configured." };
    if (identity.templateVersion !== templateVersion) {
      return { kind: "blocked" as const, reason: "stale-template" as const, message: `This template is version ${identity.templateVersion}; the current version is ${templateVersion}. Download a fresh template.` };
    }
    if (identity.reportingFrom !== context.reportingFrom || identity.reportingTo !== context.reportingTo) {
      return { kind: "blocked" as const, reason: "wrong-period" as const, message: "The template's reporting period no longer matches the job. Download a fresh template." };
    }
    const reviews = reviewSpendImportRows(rows, context);
    return { kind: "preview" as const, identity, reviews, summary: summariseImportReview(reviews) };
  });
}

export type { SpendImportPreflightState };

export async function getClientImportMapping(db: Queryable, organisationId: string, clientId: string, importKind: "spend"): Promise<{ columns: Record<string, string>; version: number } | null> {
  const { rows } = await db.query<{ mapping_json: Record<string, string>; version: number }>(
    `SELECT mapping_json,version FROM nzi_console.client_import_mappings WHERE organisation_id=$1 AND client_id=$2 AND import_kind=$3`,
    [organisationId, clientId, importKind],
  );
  return rows[0] ? { columns: rows[0].mapping_json ?? {}, version: rows[0].version } : null;
}
