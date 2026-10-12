// The v7 re-ingest commit phase (RULING-v7-allocation-decisions step 3; DESIGN-v7-reingest-commit-phase, ruled in
// REVIEW-v7-reingest-commit-phase). An imported job's enabled v7 rows are re-written as new live console rows, from a plan the
// crosswalk produces; the v7 rows they replace are switched off in the same transaction. Pure: the plan's shape, the one actor
// and reason class that may use the re-ingest-only allowances, and the post-conditions every run must meet.
import type { CommandIssue, ScopeQualityTier } from "./commands";

/** The only actor that may run a re-ingest, or use its allowances (condition 3). A system principal, run by script. */
export const V7_REINGEST_ACTOR = "policy:v7-reingest";

/**
 * D5 (ruled (a)): a v7 row that holds an emissions total and no activity quantity is carried as an explicit "reported total"
 * row — a figure, labelled as a figure, never dressed as a calculation. The closed set of reasons such a row may carry; a
 * categorised row with an override and no factor is refused for anything else, and for any actor but the re-ingest.
 */
export const V7_REPORTED_TOTAL_REASONS = ["v7 reported total, no activity data (record of account)"] as const;
export type V7ReportedTotalReason = (typeof V7_REPORTED_TOTAL_REASONS)[number];
export const isV7ReportedTotalReason = (reason: string | null | undefined): reason is V7ReportedTotalReason =>
  (V7_REPORTED_TOTAL_REASONS as readonly string[]).includes(reason ?? "");

/** The factor label a reported-total row carries, so it reads as what it is wherever the row is shown (condition 5). */
export const V7_REPORTED_TOTAL_LABEL = "v7 reported total (no activity data)";

/** The ruled tolerance (ruling 2): within 0.1% relative or 0.001 t absolute. */
export const V7_REINGEST_TOLERANCE = { relative: 0.001, absoluteTco2e: 0.001 } as const;
export const withinV7Tolerance = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= V7_REINGEST_TOLERANCE.absoluteTco2e
  || (expected !== 0 && Math.abs((actual - expected) / expected) <= V7_REINGEST_TOLERANCE.relative);

export type V7ReingestDisposition = "RE-INGEST" | "CARRY-V7-FACTOR" | "REPORTED-TOTAL";

/** One enabled v7 row of the job, and how it is re-written. The crosswalk derives these; the command checks them against the job. */
export type V7ReingestPlanRow = {
  /** The migrated row this replaces. */
  v7RowId: string;
  disposition: V7ReingestDisposition;
  /** The native category (crosswalk v1). */
  categoryCode: string;
  /** The v7 row's own scope — never moved (ruling 1's guard). */
  scope: string;
  sourceLabel: string;
  /** REPORTED-TOTAL: null — there is no activity quantity. */
  quantity: number | null;
  /** The factor's own spelling where v7's is the same unit, so calculation reads them as one. REPORTED-TOTAL: null. */
  unit: string | null;
  /** RE-INGEST: v7's own vintage factor (ruling 3). */
  datasetId?: string | null;
  factorId?: string | null;
  /** CARRY-V7-FACTOR: v7's copied factor value, carried as a job-pinned client factor (ruling 4). */
  carriedFactor?: { label: string; unit: string; kgco2ePerUnit: number; vintageYear: number } | null;
  applyPct?: number | null;
  qualityTier: ScopeQualityTier;
  /** The figure the row must reproduce: v7's reported tCO2e. */
  v7Tco2e: number;
  /** The crosswalk rule that placed it. */
  rule: string;
};

export type V7ReingestJobInput = {
  jobId: string;
  /** `v7-reingest-<uuid>`. */
  runId: string;
  crosswalkVersion: string;
  crosswalkSha256: string;
  /** v7's dataset vintages the job's rows bind to: added to the job's selection (ruling 3), never removed. */
  vintageDatasetIds: string[];
  rows: V7ReingestPlanRow[];
};

export type V7ReingestRevertInput = { jobId: string; runId: string };

const RUN_ID = /^v7-reingest-[0-9a-f-]{36}$/;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The actor gate shared by both commands (condition 3): the re-ingest's own system principal and nobody else. */
export function v7ReingestActorIssues(context: { actorId: string; principal: string }): CommandIssue[] {
  return context.actorId === V7_REINGEST_ACTOR && context.principal === "system"
    ? []
    : [{ field: "actorId", code: "REINGEST_ACTOR_ONLY", message: `Only ${V7_REINGEST_ACTOR}, as the system principal, runs a v7 re-ingest.` }];
}

/** The plan's own shape. Whether it matches the job — every enabled v7 row, its scope, its figure — is the command's check. */
export function v7ReingestPlanIssues(input: V7ReingestJobInput): CommandIssue[] {
  const issues: CommandIssue[] = [];
  const push = (field: string, code: string, message: string) => issues.push({ field, code, message });
  if (!input.jobId?.trim()) push("jobId", "REQUIRED", "A job is required.");
  if (!RUN_ID.test(input.runId ?? "")) push("runId", "INVALID", "The run id is `v7-reingest-` and a UUID.");
  if (!input.crosswalkVersion?.trim()) push("crosswalkVersion", "REQUIRED", "The crosswalk version is required.");
  if (!/^[0-9a-f]{64}$/.test(input.crosswalkSha256 ?? "")) push("crosswalkSha256", "INVALID", "The crosswalk's sha256 is 64 hex characters.");
  if (!Array.isArray(input.vintageDatasetIds) || input.vintageDatasetIds.some((id) => typeof id !== "string" || !id.trim())) push("vintageDatasetIds", "INVALID", "Vintage datasets are dataset ids.");
  if (!Array.isArray(input.rows) || input.rows.length === 0) { push("rows", "REQUIRED", "A plan has at least one row."); return issues; }
  const seen = new Set<string>();
  input.rows.forEach((row, i) => {
    const at = (field: string) => `rows[${i}].${field}`;
    if (!row.v7RowId?.trim()) push(at("v7RowId"), "REQUIRED", "Each plan row names the v7 row it replaces.");
    else if (seen.has(row.v7RowId)) push(at("v7RowId"), "DUPLICATE", `v7 row ${row.v7RowId} is planned twice.`);
    else seen.add(row.v7RowId);
    if (!row.categoryCode?.trim()) push(at("categoryCode"), "REQUIRED", "Each plan row has a native category; a row without one is for Francis, not for the re-ingest.");
    if (!row.sourceLabel?.trim()) push(at("sourceLabel"), "REQUIRED", "Each plan row carries v7's label.");
    if (!finite(row.v7Tco2e)) push(at("v7Tco2e"), "INVALID", "Each plan row carries the v7 figure it must reproduce.");
    if (!row.rule?.trim()) push(at("rule"), "REQUIRED", "Each plan row names the crosswalk rule that placed it.");
    if (row.disposition === "REPORTED-TOTAL") {
      if (row.quantity !== null || row.unit !== null || row.datasetId || row.factorId || row.carriedFactor)
        push(at("disposition"), "REPORTED_TOTAL_SHAPE", "A reported-total row has no quantity, unit or factor — it carries v7's figure, and says so.");
    } else if (row.disposition === "RE-INGEST") {
      if (!finite(row.quantity) || !row.unit?.trim() || !row.datasetId?.trim() || !row.factorId?.trim() || row.carriedFactor)
        push(at("disposition"), "REINGEST_SHAPE", "A re-ingested row has a quantity, a unit and v7's vintage factor.");
    } else if (row.disposition === "CARRY-V7-FACTOR") {
      const f = row.carriedFactor;
      if (!finite(row.quantity) || !row.unit?.trim() || row.datasetId || row.factorId || !f || !f.label?.trim() || !f.unit?.trim() || !finite(f.kgco2ePerUnit) || f.kgco2ePerUnit < 0 || !Number.isInteger(f.vintageYear))
        push(at("disposition"), "CARRY_SHAPE", "A carried row has a quantity, a unit and v7's copied factor value.");
    } else push(at("disposition"), "INVALID", "A plan row is RE-INGEST, CARRY-V7-FACTOR or REPORTED-TOTAL; anything else is for Francis.");
  });
  return issues;
}

/**
 * The v7 data-row fields the re-ingest carries onto each live row (RULING-v7-reingest-full-record), read from the stored v7 row:
 * its site (null = v7 named none, so Unallocated), its data confidence, its column text, and its monthly slots positioned on the
 * job's reporting months (null where v7 had none). The live row must equal them, field by field.
 */
export type V7CarriedFields = { siteId: string | null; dataConfidence: string | null; columnText: string | null; months: Array<number | null> | null };

export type V7ReingestPostconditionInput = {
  /** v7's enabled rows before the run: id, scope, figure, and the fields the run carries. */
  v7Rows: Array<{ rowId: string; scope: string; v7Tco2e: number } & V7CarriedFields>;
  /** The live rows the run wrote, with the figure the console now holds for each (coalesce(override, calculated)), and their fields. */
  liveRows: Array<{ rowId: string; reingestedFrom: string; scope: string; tco2e: number | null; enabled: boolean } & V7CarriedFields>;
  /** Migrated rows of the job still enabled after the run. */
  enabledMigratedAfter: number;
};

/** The top-level scope ("3.6" → "3"). */
const topScope = (scope: string) => scope.split(".")[0]!;

/**
 * D7: what every run must meet before it may commit — checked inside the transaction (and by the dry run). Each failure is
 * named; any one fails the run and rolls the whole job back.
 *  1a. Σ live = Σ v7 (the job total); 1b. Σ live = Σ v7 per scope (condition 4: a total that matches by offsetting scopes
 *      does not pass); 1c. Σ live = Σ v7 per site, Unallocated its own bucket (RULING-v7-reingest-full-record);
 *  2. every live row reproduces its v7 row — its figure, and each carried field (site, data confidence, column text, monthly
 *     slots), so two rows that swap sites with equal figures do not pass where the per-site totals alone would;
 *  3. one live row per v7 row, and no v7 row left enabled.
 */
export function v7ReingestPostconditionMisses(input: V7ReingestPostconditionInput): string[] {
  const misses: string[] = [];
  const v7ById = new Map(input.v7Rows.map((row) => [row.rowId, row]));
  const live = input.liveRows.filter((row) => row.enabled);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const v7Total = sum(input.v7Rows.map((row) => row.v7Tco2e));
  const liveTotal = sum(live.map((row) => row.tco2e ?? 0));
  if (!withinV7Tolerance(liveTotal, v7Total)) misses.push(`total: live ${liveTotal.toFixed(6)} t ≠ v7 ${v7Total.toFixed(6)} t`);
  for (const scope of [...new Set([...input.v7Rows.map((r) => topScope(r.scope)), ...live.map((r) => topScope(r.scope))])].sort()) {
    const v7 = sum(input.v7Rows.filter((row) => topScope(row.scope) === scope).map((row) => row.v7Tco2e));
    const got = sum(live.filter((row) => topScope(row.scope) === scope).map((row) => row.tco2e ?? 0));
    if (!withinV7Tolerance(got, v7)) misses.push(`scope ${scope}: live ${got.toFixed(6)} t ≠ v7 ${v7.toFixed(6)} t`);
  }
  const siteOf = (siteId: string | null) => siteId ?? "unallocated";
  for (const site of [...new Set([...input.v7Rows.map((r) => siteOf(r.siteId)), ...live.map((r) => siteOf(r.siteId))])].sort()) {
    const v7 = sum(input.v7Rows.filter((row) => siteOf(row.siteId) === site).map((row) => row.v7Tco2e));
    const got = sum(live.filter((row) => siteOf(row.siteId) === site).map((row) => row.tco2e ?? 0));
    if (!withinV7Tolerance(got, v7)) misses.push(`site ${site}: live ${got.toFixed(6)} t ≠ v7 ${v7.toFixed(6)} t`);
  }
  const linked = new Map<string, number>();
  for (const row of live) {
    linked.set(row.reingestedFrom, (linked.get(row.reingestedFrom) ?? 0) + 1);
    const v7 = v7ById.get(row.reingestedFrom);
    if (!v7) { misses.push(`row ${row.rowId}: re-ingested from ${row.reingestedFrom}, which is not an enabled v7 row of the job`); continue; }
    if (row.tco2e === null) misses.push(`row ${row.rowId}: no figure`);
    else if (!withinV7Tolerance(row.tco2e, v7.v7Tco2e)) misses.push(`row ${row.rowId}: ${row.tco2e} t ≠ v7 ${v7.v7Tco2e} t`);
    if (topScope(row.scope) !== topScope(v7.scope)) misses.push(`row ${row.rowId}: scope ${row.scope} ≠ v7's ${v7.scope}`);
    for (const field of v7CarriedFieldMisses(v7, row)) misses.push(`row ${row.rowId}: ${field}`);
  }
  for (const v7 of input.v7Rows) {
    const n = linked.get(v7.rowId) ?? 0;
    if (n !== 1) misses.push(`v7 row ${v7.rowId}: ${n} live rows (exactly one expected)`);
  }
  if (input.enabledMigratedAfter !== 0) misses.push(`${input.enabledMigratedAfter} v7 row(s) still enabled`);
  return misses;
}

/** Each carried field the live row does not equal its v7 source in, named (an empty list when it carries the record). */
export function v7CarriedFieldMisses(v7: V7CarriedFields, live: V7CarriedFields): string[] {
  const misses: string[] = [];
  const show = (value: unknown) => (value === null ? "none" : JSON.stringify(value));
  if (live.siteId !== v7.siteId) misses.push(`site ${show(live.siteId)} ≠ v7's ${show(v7.siteId)}`);
  if (live.dataConfidence !== v7.dataConfidence) misses.push(`data confidence ${show(live.dataConfidence)} ≠ v7's ${show(v7.dataConfidence)}`);
  if (live.columnText !== v7.columnText) misses.push(`column text ${show(live.columnText)} ≠ v7's ${show(v7.columnText)}`);
  const months = (value: Array<number | null> | null) => (value ?? []).map((slot) => slot ?? null);
  const a = months(live.months), b = months(v7.months);
  if (a.length !== b.length || a.some((slot, index) => (slot === null) !== (b[index] === null) || (slot !== null && Math.abs(slot - (b[index] as number)) > 1e-9)))
    misses.push(`monthly activity ${show(live.months)} ≠ v7's ${show(v7.months)}`);
  return misses;
}

/** The v7 data source → the row's quality tier (condition 5's tier half; the lineage carries the "re-ingested" mark). */
export function v7QualityTier(dataSource: string | null | undefined, unit: string | null | undefined, reportedTotal: boolean): ScopeQualityTier {
  if (reportedTotal) return "estimated";
  const source = dataSource ?? "";
  if (/^spend/i.test(source) || /^[A-Z]{3}$/.test(unit ?? "")) return "spend-based";
  if (/commuting/i.test(source)) return "survey";
  if (/previous year/i.test(source)) return "estimated";
  return "measured";
}
