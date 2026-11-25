// The import's per-job mapping view (BRIEF-v7-import-rowid-match-and-mapping-view, Part 2): every row the previous system holds for
// the job, against the mapping the console intends for it — and where that mapping comes from.
//
// A read, nothing more. It runs exactly what the refresh preview reads (`readRefresh`: the job locked, its rows from the source, its
// summary as the chain sees it, its decisions and what they resolve) in a transaction that is always rolled back, and lays each row
// out with its intended mapping:
//
//   decision — a current 0228 decision on the row (map or withdraw), resolved or stale;
//   plan     — the job's committed crosswalk plan places it;
//   console  — the row is already in the console and has not moved in what the mapping keyed on (matched / changed);
//   none     — nothing maps it yet: a person does.
//
// No command, no audit, nothing stored. The row's own detail (label, site, quantity, factor, figure) is read live, shown, and gone.
import { resolveV7Import, type V7ImportDecision, type V7ImportResolvedVerdict, type V7ImportRowStatus, type V7ImportScope, type V7ImportScopeTotals, type V7ReingestJobInput } from "@nzi/contracts";
import { assertCapabilityOnClient, type CapabilityHolder } from "./access";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";
import { invalidApplied } from "./v7ImportDecision";
import { committedV7CrosswalkPlan, readRefresh, type Refresh, type V7ImportRefreshOptions, type V7ImportRefreshSource } from "./v7ImportRefresh";
import { readV7ImportView } from "./v7ImportSummary";
import { resolveV7SiteTokens } from "./v7SiteLinks";

export type V7ImportMappingSource = "decision" | "plan" | "console" | "none";
/** Why a row needs a person: the same states the refresh preview's exceptions carry, as one code. */
export type V7ImportMappingFlag = "NEW" | "NEEDS_MAPPING" | "WITHDRAWN" | "DECISION_STALE" | "PAIR_TO_CARRY" | "NEEDS_FRESH_SUMMARY";

export type V7ImportMappingRow = {
  legacyDbId: string; status: V7ImportRowStatus; ownStatus: Exclude<V7ImportRowStatus, "linked-pair-changed">; scope: V7ImportScope;
  /** The previous system, as it stands now (a withdrawn row: as the console last held it). */
  previous: { label: string | null; siteName: string | null; quantity: number | null; unit: string | null; factorCode: string | null; factor: number | null;
    factorUnit: string | null; tco2e: number | null; enabled: boolean | null };
  /** The console, intended: a category and a factor (none for a withdrawal or an unmapped row). */
  intended: { categoryCode: string | null; datasetId: string | null; factorId: string | null; withdraw: boolean };
  source: V7ImportMappingSource;
  flag: V7ImportMappingFlag | null;
  resolution: ReturnType<typeof resolveV7Import>["rows"][number]["resolution"];
  decision: V7ImportDecision | null; invalid: string | null;
};

export type V7ImportMapping = {
  jobId: string; legacyJobNumber: string; verdict: V7ImportResolvedVerdict; scopeTotals: V7ImportScopeTotals;
  rows: V7ImportMappingRow[];
  /** The job's latest stored summary is this one, so a decision saved inline is checked against what is shown. */
  summaryCurrent: boolean;
  /** The console holds only the previous system's scope totals for this job (or nothing), and the previous system now has rows. */
  firstTimeMapping: boolean;
};

class MappingRollback extends Error {}
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value ?? null);
const num = (value: unknown) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const str = (value: unknown) => typeof value === "string" && value.trim() ? value : null;

/** The previous system's scope totals as its WFM import wrote them (`wfm-import-scope-N`): no category, no activity. */
export const V7_SCOPE_TOTAL_CODE = /^wfm-import-scope-[123]$/;

/**
 * SQL: whether every current imported row the console holds for a job is one of the previous system's scope totals — or it holds
 * none. One expression, shared by the mapping read and the batch's queue, so the two cannot disagree.
 */
export const v7TotalsOnlySql = (organisation: string, job: string) =>
  `coalesce((SELECT bool_and(coalesce(m.migrated_record->>'original_id' ~ '^wfm-import-scope-[123]$', false)) FROM nzi_console.job_scope_rows m
     WHERE m.organisation_id = ${organisation} AND m.job_id = ${job} AND m.origin = 'migrated' AND m.superseded_by_row_id IS NULL), true)`;

export async function v7JobIsTotalsOnly(db: Queryable, organisationId: string, jobId: string): Promise<boolean> {
  return (await db.query<{ totals_only: boolean }>(`SELECT ${v7TotalsOnlySql("$1", "$2")} AS totals_only`, [organisationId, jobId])).rows[0]!.totals_only;
}

/**
 * The mapping, for a holder of `import.refresh` on the job (the refresh command's own rule: capability, tenant, own clients), read
 * in a transaction that is always rolled back.
 */
export async function readV7ImportMapping(pool: PoolLike, source: V7ImportRefreshSource, holder: CapabilityHolder, jobId: string,
  options: Pick<V7ImportRefreshOptions, "basePlan"> = {}): Promise<V7ImportMapping> {
  let mapping: V7ImportMapping | null = null;
  try {
    await withTenantWrite(pool, holder.organisationId, async (db) => {
      await assertCapabilityOnClient(db, holder, "import.refresh", { jobId });
      mapping = (await buildV7ImportMapping(db, source, holder.organisationId, jobId, options.basePlan)).mapping;
      throw new MappingRollback();
    });
  } catch (error) {
    if (!(error instanceof MappingRollback)) throw error;
  }
  return mapping!;
}

/**
 * The mapping, inside the caller's transaction, with what it was read from (the refresh's own read) — for a read that lays more
 * beside each row (the import rows modal's candidates). Writes nothing; the caller rolls back.
 */
export async function buildV7ImportMapping(db: Queryable, source: V7ImportRefreshSource, org: string, jobId: string, basePlan?: Omit<V7ReingestJobInput, "runId">): Promise<{ mapping: V7ImportMapping; read: Refresh }> {
  const read = await readRefresh(db, source, org, jobId);
  const plan = basePlan ?? committedV7CrosswalkPlan(jobId, read.legacyJobNumber);
  const planned = new Map(plan.rows.map((row) => [row.v7RowId, row]));
  const invalid = await invalidApplied(db, org, read.decisions);
  const stored = await readV7ImportView(db, jobId);
  const summaryCurrent = stored !== null && stable(stored.rows) === stable(read.summary.rows);
  const sources = new Map(read.rows.map((row) => [row.legacyDbId, row]));
  // The console's side: each imported row's current mapping (the live row a standing re-ingest made from it, else the row itself),
  // and — for a row gone from the previous system — what it last held there.
  const held = new Map((await db.query<{ legacy_db_id: string; scope: string; dataset_id: string | null; factor_id: string | null; source_label: string;
    site_name: string | null; record: Record<string, unknown> }>(
    `SELECT m.legacy_db_id, coalesce(l.scope, m.scope) AS scope, coalesce(l.dataset_id, m.dataset_id) AS dataset_id, coalesce(l.factor_id, m.factor_id) AS factor_id,
            m.source_label, s.name AS site_name, m.migrated_record AS record
       FROM nzi_console.job_scope_rows m
       LEFT JOIN nzi_console.job_scope_rows l ON (l.organisation_id, l.reingested_from_row_id) = (m.organisation_id, m.scope_row_id) AND l.origin = 'live' AND l.superseded_by_row_id IS NULL
       LEFT JOIN nzi_console.client_sites s ON (s.organisation_id, s.site_id) = (m.organisation_id, m.site_id)
      WHERE m.organisation_id = $1 AND m.job_id = $2 AND m.origin = 'migrated' AND m.superseded_by_row_id IS NULL`, [org, jobId])).rows.map((row) => [row.legacy_db_id, row]));
  // Each row's V7 site named as its console site (0235): a merged site reads as the survivor.
  const siteOf = await resolveV7SiteTokens(db, org, read.rows.map((row) => row.siteId));
  const siteIds = [...new Set(read.rows.map((row) => siteOf(row.siteId)).filter((id): id is string => id !== null))];
  const consoleNames = new Map((await db.query<{ site_id: string; name: string }>(
    `SELECT site_id, name FROM nzi_console.client_sites WHERE organisation_id = $1 AND site_id = ANY($2::text[])`, [org, siteIds])).rows.map((row) => [row.site_id, row.name]));
  const siteNames = { get: (token: string) => consoleNames.get(siteOf(token) ?? "") };

  const rows = read.resolved.rows.map((resolved, at): V7ImportMappingRow => {
    const summaryRow = read.summary.rows[at]!;
    const now = sources.get(resolved.legacyDbId);
    const was = held.get(resolved.legacyDbId);
    const record = (now?.migratedRecord ?? was?.record ?? {}) as unknown as Record<string, unknown>;
    const previous = {
      label: now?.sourceLabel ?? was?.source_label ?? null,
      siteName: now ? (now.siteId ? siteNames.get(now.siteId) ?? null : null) : was?.site_name ?? null,
      quantity: num(record.qty), unit: str(record.uom), factorCode: str(record.original_id), factor: num(record.factor), factorUnit: str(record.ghg_unit),
      tco2e: summaryRow.v7Figure ?? (now ? null : num(record.reported_tco2e)), enabled: summaryRow.v7Enabled,
    };
    // A decision counts only where the row needs one now: on a matched or changed row it has nothing to decide.
    const decision = resolved.resolution === "resolved" || resolved.resolution === "stale" ? resolved.decision : null;
    const planRow = now ? planned.get(now.scopeRowId) : undefined;
    let source: V7ImportMappingSource = "none";
    let intended: V7ImportMappingRow["intended"] = { categoryCode: null, datasetId: null, factorId: null, withdraw: false };
    if (decision) {
      source = "decision";
      intended = decision.kind === "withdraw" ? { ...intended, withdraw: true } : { categoryCode: decision.categoryCode, datasetId: decision.datasetId, factorId: decision.factorId, withdraw: false };
    } else if (planRow && resolved.ownStatus !== "new" && resolved.ownStatus !== "needs-mapping") {
      source = "plan";
      intended = { categoryCode: planRow.categoryCode, datasetId: planRow.disposition === "RE-INGEST" ? planRow.datasetId ?? null : null,
        factorId: planRow.disposition === "RE-INGEST" ? planRow.factorId ?? null : null, withdraw: false };
    } else if (was && (resolved.ownStatus === "matched" || resolved.ownStatus === "changed")) {
      source = "console";
      intended = { categoryCode: was.scope, datasetId: was.dataset_id, factorId: was.factor_id, withdraw: false };
    }
    const flag: V7ImportMappingFlag | null = resolved.carry === "awaiting" ? "PAIR_TO_CARRY" : resolved.carry === "needs-fresh-summary" ? "NEEDS_FRESH_SUMMARY"
      : resolved.resolution === "stale" ? "DECISION_STALE"
        : resolved.resolution !== "unresolved" ? null
          : resolved.ownStatus === "new" ? "NEW" : resolved.ownStatus === "withdrawn" ? "WITHDRAWN" : "NEEDS_MAPPING";
    return { legacyDbId: resolved.legacyDbId, status: summaryRow.status, ownStatus: resolved.ownStatus, scope: summaryRow.scope, previous, intended, source, flag,
      resolution: resolved.resolution, decision, invalid: decision ? invalid.get(decision.decisionId) ?? null : null };
  });
  const firstTimeMapping = read.summary.counts.new > 0 && await v7JobIsTotalsOnly(db, org, jobId);
  return { mapping: { jobId, legacyJobNumber: read.legacyJobNumber, verdict: read.resolved.verdict, scopeTotals: read.summary.scopeTotals, rows, summaryCurrent, firstTimeMapping }, read };
}
