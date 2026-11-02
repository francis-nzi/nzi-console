import {
  importRowIssue, importRowStatus, isCurrencyUnit, spendCategoryOf, spendImportNote,
  type CommandContext, type CommandInputMap, type ImportRowReview, type PortalScopeRowFields, type PortalSpendImportPreview, type PortalSpendLineReview, type SpendImportRow,
} from "@nzi/contracts";
import { assertPortalJobAccess } from "./portalCapture";
import { clientCategoryGate } from "./portalProfile";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import type { PortalPrincipal } from "./auth";
import { loadSpendImportContext, reviewSpendImportRows, routedImportRow, type SpendImportJobContext } from "./spendImport";
import { issueSpendImportIdentity, SPEND_IMPORT_TEMPLATE_VERSION, verifySpendImportToken } from "./spendImportIdentity";

/**
 * The client portal's spend import, Phase A (RULING-portal-import-spend). The CRM's own review runs on every line — the allocation map
 * routes it, the job's existing lines and the carried-forward ones are read first — and the portal adds only what a client's reach
 * needs:
 *
 *  - **Filed where the map says.** The client sees the category and cannot change it; unmapped lines fall to the PG&S residual (staff
 *    re-route on review). A line routed to a category the client is not shown, or priced by a client factor the portal never offers,
 *    is held (`NOT_IMPORTABLE_HERE`) without saying why.
 *  - **Rows, not sources.** Each accepted line becomes one pending scope row (spend basis, the factor's currency unit, the GL code and
 *    invoice date in the note so a re-import and staff both see it was filed). Nothing is written to the staff register.
 *  - **Never fills a carried-forward line.** A line whose GL code a carried line holds is left for the adviser, and said.
 *  - **Pinned to the period and template version** by the signed identity the server issued, verified here inside the transaction.
 */
type PortalReview = { review: ImportRowReview; row: SpendImportRow; category: string | null; scope: string | null; matchesCarried: boolean };

const scopeOf = (code: string) => (/^3\.\d+$/.test(code) ? code : code.split(".")[0]!);

/** The CRM's review of every line, then the portal's own checks on top of it. */
export async function reviewForPortal(db: Queryable, organisationId: string, clientId: string, context: SpendImportJobContext, lines: SpendImportRow[]): Promise<{ reviews: PortalReview[]; factors: Map<string, { label: string; unit: string; version: string }> }> {
  const gate = await clientCategoryGate(db, clientId);
  const base = reviewSpendImportRows(lines, context);
  // The factor each routed line will carry: its label, its unit (must be money) and its dataset's version.
  const factors = new Map<string, { label: string; unit: string; version: string }>();
  const reviews = await Promise.all(lines.map(async (original, index): Promise<PortalReview> => {
    const review = base[index]!;
    const { row } = routedImportRow(original, context.allocations);
    const code = review.routing?.categoryCode ?? null;
    const scope = code ? scopeOf(code) : null;
    const issues = review.issues;
    if (code && scope && !gate.shows(code, scope)) issues.push(importRowIssue("NOT_IMPORTABLE_HERE", "This line can't be imported here. Ask your adviser."));
    else if (row.factorSource === "client") issues.push(importRowIssue("NOT_IMPORTABLE_HERE", "This line can't be imported here. Ask your adviser."));
    else if (row.factorId && row.datasetId && !issues.some((issue) => issue.code === "FACTOR_UNRESOLVED")) {
      const key = `${row.datasetId}|${row.factorId}`;
      if (!factors.has(key)) {
        const found = (await db.query<{ label: string; activity_unit: string; version: string }>(
          `SELECT f.label,f.activity_unit,d.version FROM nzi_console.emission_factors f JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id,d.dataset_id)=(f.organisation_id,f.dataset_id)
            WHERE f.organisation_id=$1 AND f.dataset_id=$2 AND f.factor_id=$3`, [organisationId, row.datasetId, row.factorId])).rows[0];
        if (found) factors.set(key, { label: found.label, unit: found.activity_unit, version: String(found.version) });
      }
      const factor = factors.get(key);
      if (!factor) issues.push(importRowIssue("FACTOR_UNRESOLVED", "Emission factor is not available on this job."));
      else if (!isCurrencyUnit(factor.unit)) issues.push(importRowIssue("FACTOR_UNRESOLVED", "That factor isn't priced per amount spent. Choose a spend factor."));
    } else if (row.factorId && !row.datasetId && !issues.some((issue) => issue.code === "FACTOR_UNRESOLVED")) {
      issues.push(importRowIssue("FACTOR_UNRESOLVED", "Emission factor is not available on this job."));
    }
    review.status = importRowStatus(issues);
    return { review, row, category: code, scope, matchesCarried: review.reconciliation?.kind === "fills-carried" };
  }));
  return { reviews, factors };
}

const toLineReview = (item: PortalReview): PortalSpendLineReview => ({
  rowNumber: item.review.rowNumber, status: item.review.status, issues: item.review.issues,
  // A category the client is not shown is never named: a held line says only that it can't be imported here.
  filedUnder: item.category && !item.review.issues.some((issue) => issue.code === "NOT_IMPORTABLE_HERE") ? spendCategoryOf(item.category)?.name ?? item.category : null,
  alreadyImported: item.review.reconciliation?.kind === "already-imported", matchesCarried: item.matchesCarried,
});

/** The preview: read-only, a convenience the commit never trusts (it reviews again, inside its transaction). */
export async function previewPortalSpendImport(pool: PoolLike, principal: PortalPrincipal, jobId: string, lines: SpendImportRow[], secret: string | undefined): Promise<PortalSpendImportPreview> {
  const issued = await issueSpendImportIdentity(pool, principal.organisationId, jobId, secret);
  if (!issued) return { kind: "blocked", reason: "job-not-found", message: "This job has no reporting period set yet, so nothing can be imported." };
  return withTenantRead(pool, principal.organisationId, async (db) => {
    await assertPortalJobAccess(db, principal, jobId);
    const context = await loadSpendImportContext(db, principal.organisationId, jobId);
    if (!context) return { kind: "blocked" as const, reason: "job-not-found" as const, message: "This job has no reporting period set yet, so nothing can be imported." };
    const { reviews } = await reviewForPortal(db, principal.organisationId, principal.clientId, context, lines);
    const mapped = reviews.map(toLineReview);
    const importable = mapped.filter((review) => review.status !== "blocked" && !review.alreadyImported && !review.matchesCarried);
    return {
      kind: "preview" as const, reviews: mapped,
      summary: {
        total: mapped.length, importable: importable.length, advisory: importable.filter((review) => review.status === "advisory").length,
        blocked: mapped.filter((review) => review.status === "blocked").length, alreadyImported: mapped.filter((review) => review.alreadyImported).length, matchesCarried: mapped.filter((review) => review.matchesCarried && review.status !== "blocked").length,
      },
    };
  });
}

export type PortalSpendImportResult = { rowIds: string[]; count: number; alreadyImported: number; matchesCarried: number; blocked: number };

/**
 * The commit, inside `portal.scope.row.import`'s transaction. Verifies the identity, reviews the lines against the job as it is now,
 * and files each importable line through `fileRow` — the create command's own path (shown-category gate, staff-only fields fixed, the
 * CRM's row handler). A line that is blocked, already here or matched to a carried-forward line is counted and left; the rest commit
 * together or not at all.
 */
export async function importPortalSpendLines(
  db: Queryable, input: CommandInputMap["portal.scope.row.import"], context: CommandContext, secret: string | undefined,
  fileRow: (fields: PortalScopeRowFields) => Promise<string>,
): Promise<PortalSpendImportResult> {
  const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);
  const spend = input.spend!;
  const verified = verifySpendImportToken(spend.token, secret);
  if (!verified.ok) throw refuse("spend.token", verified.reason.toUpperCase().replace(/-/g, "_"), "The import's identity could not be verified. Start again.");
  if (verified.identity.jobId !== input.jobId) throw refuse("spend.token", "WRONG_JOB", "This import was prepared for a different job.");
  const job = await loadSpendImportContext(db, context.organisationId, input.jobId);
  if (!job) throw refuse("jobId", "NOT_CONFIGURED", "This job has no reporting period set yet, so nothing can be imported.");
  if (verified.identity.templateVersion !== SPEND_IMPORT_TEMPLATE_VERSION) throw refuse("spend.token", "STALE_TEMPLATE", "This template is out of date. Download a fresh one.");
  if (verified.identity.reportingFrom !== job.reportingFrom || verified.identity.reportingTo !== job.reportingTo) throw refuse("spend.token", "WRONG_PERIOD", "The job's reporting period has changed. Start again.");

  const { reviews, factors } = await reviewForPortal(db, context.organisationId, context.portal!.clientId, job, spend.lines);
  const result: PortalSpendImportResult = { rowIds: [], count: 0, alreadyImported: 0, matchesCarried: 0, blocked: 0 };
  for (const item of reviews) {
    if (item.review.status === "blocked") { result.blocked += 1; continue; }
    if (item.review.reconciliation?.kind === "already-imported") { result.alreadyImported += 1; continue; }
    if (item.matchesCarried) { result.matchesCarried += 1; continue; }
    const { row, category } = item;
    const factor = factors.get(`${row.datasetId}|${row.factorId}`)!;
    const fields = {
      scope: scopeOf(category!), categoryCode: category!, sourceLabel: row.description.trim().slice(0, 240), siteId: null,
      quantity: row.netValue, unit: factor.unit, monthlyActivity: [], entryBasis: "spend",
      datasetId: row.datasetId, factorId: row.factorId, factorVersion: factor.version, factorLabel: factor.label,
      purchasedGoodsCategoryId: category === "3.1" ? row.purchasedGoodsCategoryId : null,
      notes: spendImportNote(row),
    } as PortalScopeRowFields;
    try { result.rowIds.push(await fileRow(fields)); }
    catch (error) {
      if (error instanceof CommandValidationError) throw new CommandValidationError(error.issues.map((issue) => ({ ...issue, field: `spend.lines[${item.review.rowNumber}].${issue.field}`, message: `Line ${item.review.rowNumber}: ${issue.message}` })));
      throw error;
    }
  }
  result.count = result.rowIds.length;
  return result;
}
