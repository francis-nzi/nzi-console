/**
 * JW-13 step 3 — fill the automatic datasets of imported CRP jobs that have none, through the governed
 * `job.datasets.autoSelect`, behind the staging gate.
 *
 *   npm run backfill:job-datasets -w @nzi/isolated-backend -- --reason "<why>" [--organisation <id>] [--commit]
 *
 * Fill-blank-only: a job holding any selection is left alone (counted). The rule is #413's — the GB and GLOBAL editions
 * valid on the window's last day. Jobs with no window, no matching edition, or a window ending implausibly late are
 * listed as MANUAL FIXES and never guessed at. A dry run is the whole run, rolled back; a savepoint per job, so one
 * refusal never stops the run. The actor is the system principal `policy:jw13-dataset-backfill` with the admin grant
 * (the staffAdmin break-glass precedent); the reason travels on every audit event. Output is job numbers, dates and
 * dataset names only — no client names, nothing personal. Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { runJobDatasetBackfill, type BackfillLine, type ManualFixKind } from "../src/jobDatasetBackfill";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
/** A SQL `date` as text (YYYY-MM-DD) shown dd/mm/yyyy — string work, no Date, so no day can shift. */
const day = (value: string) => { const [y, m, d] = value.split("-"); return `${d}/${m}/${y}`; };
const windowOf = (line: BackfillLine) => line.window ? `${day(line.window.from)}–${day(line.window.to)}` : "no window";

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const reason = argument("--reason")?.trim();
  const commit = process.argv.includes("--commit");
  if (!reason) throw new Error("--reason is required.");
  const url = validateDatabaseBoundary({ appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nJW-13 dataset backfill for imported CRP jobs (${organisationId}) — ${commit ? "COMMIT" : "dry run: the whole run, rolled back"}`);
  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-jw13-dataset-backfill" });
  let outcome;
  try {
    outcome = await runJobDatasetBackfill(pool, organisationId, { commit, reason });
  } finally {
    await pool.end();
  }
  log(`  run ${outcome.runId} · reason: ${outcome.reason}\n`);

  for (const line of outcome.lines) {
    const result = line.result === "filled" ? (commit ? "filled" : "would fill")
      : line.result === "manual" ? `MANUAL FIX — ${line.manualKind}` : `ERROR — ${line.detail}`;
    log(`  ${line.jobNumber} · ${windowOf(line)} · ${line.datasets.length ? line.datasets.join(", ") : "—"} · ${result}`);
  }

  const manual = outcome.lines.filter((line) => line.result === "manual");
  const kinds: ManualFixKind[] = ["NO_WINDOW", "NO_EDITION", "IMPLAUSIBLE_WINDOW"];
  log(`\nMANUAL FIXES (${manual.length})`);
  if (manual.length === 0) log("  none");
  for (const kind of kinds) {
    const these = manual.filter((line) => line.manualKind === kind);
    if (these.length) log(`  ${kind} (${these.length}): ${these.map((line) => `${line.jobNumber} [${windowOf(line)}]`).join(", ")}`);
  }

  const filled = outcome.lines.filter((line) => line.result === "filled");
  const errors = outcome.lines.filter((line) => line.result === "error");
  log("\nTotals");
  log(`  candidates (imported CRP, no selection): ${outcome.candidates}`);
  log(`  ${commit ? "filled" : "would fill"}: ${filled.length}`);
  log(`  datasets selected: ${filled.reduce((sum, line) => sum + line.datasets.length, 0)}`);
  log(`  manual fixes: ${kinds.map((kind) => `${kind} ${manual.filter((line) => line.manualKind === kind).length}`).join(" · ")}`);
  log(`  unexpected errors: ${errors.length}`);
  log(`  already selected, left alone: ${outcome.alreadySelected}`);
  log(`  re-run candidates: ${outcome.rerunCandidates} (manual fixes ${manual.length})`);
  log(`  re-run would fill: ${outcome.rerunWouldFill}${outcome.rerunWouldFill === 0 ? "" : " — POST-CONDITION MISS: expected 0"}`);
  if (errors.length || outcome.rerunWouldFill !== 0) process.exitCode = 1;
  if (!commit) log("\nDry run complete. Re-run with --commit to write.");
}

main().catch((error) => { process.stderr.write(`\nbackfill-job-datasets failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
