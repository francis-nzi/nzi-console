import {
  importRowIssue,
  reviewSpendImportRow,
  spendImportRowKey,
  summariseImportReview,
  type ImportRowReview,
  type SpendImportIdentity,
  type SpendImportPreflightState,
  type SpendImportRow,
} from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { withTenantRead } from "./postgres";

export type SpendImportJobContext = {
  reportingFrom: string;
  reportingTo: string;
  categoryIds: Set<string>;
  factorIds: Set<string>;
  clientFactorIds: Set<string>;
  existingKeys: Set<string>; // description|net|gl of live (non-voided) spend sources on this job
};

export async function loadSpendImportContext(db: Queryable, organisationId: string, jobId: string): Promise<SpendImportJobContext | null> {
  const config = await db.query<{ reporting_from: Date | string; reporting_to: Date | string }>(
    `SELECT reporting_from,reporting_to FROM nzi_console.job_emissions_config WHERE organisation_id=$1 AND job_id=$2`,
    [organisationId, jobId],
  );
  const row = config.rows[0];
  if (!row) return null;
  const day = (value: Date | string) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
  const categories = await db.query<{ category_id: string }>(
    `SELECT c.category_id FROM nzi_console.purchased_goods_categories c JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(c.organisation_id,c.client_id) WHERE c.organisation_id=$1 AND j.job_id=$2`,
    [organisationId, jobId],
  );
  const factors = await db.query<{ factor_id: string }>(
    `SELECT f.factor_id FROM nzi_console.job_dataset_selections s JOIN nzi_console.emission_factors f ON (f.organisation_id,f.dataset_id)=(s.organisation_id,s.dataset_id) WHERE s.organisation_id=$1 AND s.job_id=$2 AND f.active=true`,
    [organisationId, jobId],
  );
  const clientFactors = await db.query<{ client_factor_id: string }>(
    `SELECT cf.client_factor_id FROM nzi_console.client_factors cf JOIN nzi_console.jobs j ON (j.organisation_id,j.client_id)=(cf.organisation_id,cf.client_id) WHERE cf.organisation_id=$1 AND j.job_id=$2 AND (cf.job_id IS NULL OR cf.job_id=j.job_id) AND cf.archived=false`,
    [organisationId, jobId],
  );
  const existing = await db.query<{ source_name: string; quantity: string | null; source_subtype: string | null }>(
    `SELECT source_name,quantity,source_subtype FROM nzi_console.job_emission_sources WHERE organisation_id=$1 AND job_id=$2 AND source_type='spend' AND voided_at IS NULL`,
    [organisationId, jobId],
  );
  return {
    reportingFrom: day(row.reporting_from),
    reportingTo: day(row.reporting_to),
    categoryIds: new Set(categories.rows.map((r) => r.category_id)),
    factorIds: new Set(factors.rows.map((r) => r.factor_id)),
    clientFactorIds: new Set(clientFactors.rows.map((r) => r.client_factor_id)),
    existingKeys: new Set(
      existing.rows.map((r) => spendImportRowKey({ description: r.source_name, netValue: r.quantity == null ? null : Number(r.quantity), glCode: r.source_subtype })),
    ),
  };
}

/** Server-authoritative row review — file-local + job context + the ALREADY_IMPORTED advisory. */
export function reviewSpendImportRows(rows: SpendImportRow[], context: SpendImportJobContext): ImportRowReview[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = spendImportRowKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return rows.map((row) => {
    const key = spendImportRowKey(row);
    const review = reviewSpendImportRow(row, context, (counts.get(key) ?? 0) > 1);
    if (context.existingKeys.has(key)) {
      review.issues.push(importRowIssue("ALREADY_IMPORTED", "A live spend source on this job already has this description, net value and GL code."));
      if (review.status === "accepted") review.status = "advisory";
    }
    return review;
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
