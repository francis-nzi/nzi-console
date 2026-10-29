// RULING-v7-book-runner (BUILD-v7-history-book-runner, 29 Oct 2026) — the v7 re-ingest across the book. Not a new transform: each
// job is the ruled `v7.reingest.job` (0166), from its crosswalk-v1 plan, in its own transaction — a dry run rolled back, a commit
// only when asked — with three decisions made before the command runs:
//
//   - **Held** (R1): J000663 stays as it is (Cowork, 21 Oct, Option 2) — never re-run, whatever its plan says.
//   - **Open residual** (R7): a plan that names any row still on `residuals-for-francis.csv` waits for Francis's sign-off; the
//     job is skipped and says how many of its rows are open. Never guessed.
//   - **The year edition** (R6): a job with no dataset of its reporting year selected gets the one edition that is — the
//     country's preferred source for that year, added through the command's own vintage selection (audited, added never
//     removed). None, or two equally preferred, and the job is flagged and skipped: never guessed.
//
// A job's outcome is a status the owner reads: PASS (input carried, no material emission delta), FLAGGED (input carried, deltas to
// investigate before attesting), REFUSED (the command refused — its quantity gate, a site, months… — nothing written), or a skip.
// tCO2e and ids only, never a label (NZC-120).
import { datasetPreferenceRank, type CommandContext, type V7ReingestJobInput } from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import { reingestV7JobInTransaction, type V7ReingestResult } from "./v7Reingest";

/** Jobs the runner never re-ingests, and why (R1: J000663 stays as it is). */
export const V7_BOOK_HELD_JOBS: Readonly<Record<string, string>> = {
  "v7-job-663": "J000663 stays as it is — re-ingested, snapshotted and ruled to be left (21 Oct, Option 2)",
};

export type V7BookPlan = Omit<V7ReingestJobInput, "runId">;
export type V7BookSkip = { status: "HELD" | "OPEN_RESIDUAL" | "NO_YEAR_EDITION"; reason: string };

/** R1 / R7: whether a job's plan may run at all — held, or naming a row still open for Francis. */
export function v7BookSkip(plan: V7BookPlan, openResiduals: ReadonlySet<string>): V7BookSkip | null {
  const held = V7_BOOK_HELD_JOBS[plan.jobId];
  if (held) return { status: "HELD", reason: held };
  const open = plan.rows.filter((row) => openResiduals.has(row.v7RowId)).length;
  if (open) return { status: "OPEN_RESIDUAL", reason: `${open} of its ${plan.rows.length} rows await Francis's sign-off (residuals-for-francis.csv)` };
  return null;
}

export type V7YearEdition =
  | { kind: "selected"; datasetIds: string[] }
  | { kind: "add"; datasetId: string }
  | { kind: "none" | "ambiguous"; reason: string };

/**
 * R6: the job's reporting-year edition. Already selected — nothing to do. Otherwise the active editions of the job's country whose
 * year is the reporting year, ranked by the country's source preference (DESNZ for GB): one at the top is added; none, or a tie at
 * the top, is flagged.
 */
export async function v7YearEdition(db: Queryable, organisationId: string, jobId: string): Promise<V7YearEdition> {
  const { rows: [job] } = await db.query<{ reporting_year: number | null; country_code: string | null }>(
    `SELECT coalesce(j.reporting_year, extract(year FROM j.start_date)::int) AS reporting_year, c.country_code
       FROM nzi_console.jobs j LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
      WHERE j.organisation_id = $1 AND j.job_id = $2`, [organisationId, jobId]);
  if (!job?.reporting_year) return { kind: "none", reason: "the job has no reporting year" };
  const year = job.reporting_year, country = job.country_code ?? "GB";
  const selected = (await db.query<{ dataset_id: string }>(
    `SELECT s.dataset_id FROM nzi_console.job_dataset_selections s
       JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (s.organisation_id, s.dataset_id)
      WHERE s.organisation_id = $1 AND s.job_id = $2 AND extract(year FROM d.valid_from)::int = $3 ORDER BY s.dataset_id`,
    [organisationId, jobId, year])).rows.map((row) => row.dataset_id);
  if (selected.length) return { kind: "selected", datasetIds: selected };
  const candidates = (await db.query<{ dataset_id: string }>(
    `SELECT dataset_id FROM nzi_console.emission_factor_datasets
      WHERE organisation_id = $1 AND status = 'active' AND country_code = $2 AND extract(year FROM valid_from)::int = $3 ORDER BY dataset_id`,
    [organisationId, country, year])).rows.map((row) => row.dataset_id);
  if (!candidates.length) return { kind: "none", reason: `no ${country} edition of ${year} exists to select` };
  const ranked = candidates.map((id) => ({ id, rank: datasetPreferenceRank(id, country) })).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  if (ranked.length > 1 && ranked[0]!.rank === ranked[1]!.rank)
    return { kind: "ambiguous", reason: `${ranked.filter((c) => c.rank === ranked[0]!.rank).length} ${country} editions of ${year} are equally preferred (${ranked.filter((c) => c.rank === ranked[0]!.rank).map((c) => c.id).join(", ")})` };
  return { kind: "add", datasetId: ranked[0]!.id };
}

export type V7BookJobOutcome =
  | { status: "PASS" | "FLAGGED"; jobId: string; result: V7ReingestResult; yearEditionAdded: string | null }
  | { status: "REFUSED"; jobId: string; issues: Array<{ field: string; code: string; message: string }> }
  | ({ jobId: string } & V7BookSkip);

/**
 * One job of the book, inside the caller's transaction (the runner gives each job its own; a dry run rolls it back): the skip
 * rules, the year edition, then the ruled command. A refusal is the job's outcome, not the book's — the caller rolls this
 * job's transaction back and goes on to the next.
 */
export async function runV7BookJobInTransaction(db: Queryable, plan: V7BookPlan, runId: string, openResiduals: ReadonlySet<string>, context: CommandContext): Promise<V7BookJobOutcome> {
  const skip = v7BookSkip(plan, openResiduals);
  if (skip) return { jobId: plan.jobId, ...skip };
  const edition = await v7YearEdition(db, context.organisationId, plan.jobId);
  if (edition.kind === "none" || edition.kind === "ambiguous") return { jobId: plan.jobId, status: "NO_YEAR_EDITION", reason: edition.reason };
  const vintageDatasetIds = edition.kind === "add" ? [...new Set([...plan.vintageDatasetIds, edition.datasetId])].sort() : plan.vintageDatasetIds;
  try {
    const outcome = await reingestV7JobInTransaction(db, { ...plan, vintageDatasetIds, runId }, context);
    return { status: outcome.data.deltas.flagged.length ? "FLAGGED" : "PASS", jobId: plan.jobId, result: outcome.data,
      yearEditionAdded: edition.kind === "add" ? edition.datasetId : null };
  } catch (error) {
    if (error instanceof CommandValidationError) return { status: "REFUSED", jobId: plan.jobId, issues: error.issues };
    throw error;
  }
}

/** The residual rows still open: every `scope_row_id` on residuals-for-francis.csv, less those Francis has signed off. */
export function openV7Residuals(residualsCsv: string, signedOff: ReadonlySet<string> = new Set()): Set<string> {
  const [header, ...lines] = residualsCsv.split(/\r?\n/).filter((line) => line.trim());
  const at = splitCsvLine(header ?? "").indexOf("scope_row_id");
  if (at < 0) throw new Error("The residuals file has no scope_row_id column.");
  return new Set(lines.map((line) => splitCsvLine(line)[at]?.trim() ?? "").filter((id) => id && !signedOff.has(id)));
}

/** One CSV line, quotes honoured (the residuals carry v7's labels, which may hold commas). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "", quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out;
}
