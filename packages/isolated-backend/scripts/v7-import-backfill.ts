/**
 * The reviewed backfill (R2; DESIGN-backfill-reprice-and-reselect, ruled 27 Nov 2026): existing imported jobs moved onto the
 * datasets-by-period rules — each job's country (C), its datasets (B), its UAE rows (D) and, on a two-year job, its months re-read by
 * calendar month and its rows re-priced (A) — and written only on the owner's approval.
 *
 *   NZI_V7_VIEW_URL=… NZI_V7_FIGURES_URL=… NZI_V7_FIGURES_TOKEN=… \
 *     npm run v7:import-backfill -w @nzi/isolated-backend -- --as <Admin user id> --reason "<why, ≥ 8 characters>" \
 *       [--jobs <J000265,… | file>] [--report <file.csv>] [--organisation <id>] [--commit --approved <approved.csv>]
 *
 * A dry run unless `--commit`: each job's whole act, rolled back. Its `--report` CSV is the list Francis approves: a job he keeps as
 * `would-write` is approved. `--commit` needs `--jobs` and `--approved` (that CSV): it writes only the jobs named, and only where the
 * recomputed after equals the approved one (± 0.005 t per scope); then a drift check (trigger `backfill`). One job per transaction;
 * endpoint 2 through the 2 s floor; three jobs in a row with the previous system not answering stop the run. A two-year job is written
 * only if it then reconciles with the previous system's own figures within 0.1 t in every scope, or it is listed whole. Moved rows go
 * back to pending: re-attest with `v7:batch-attest`. Runs on the app role (withTenantWrite); fail-closed on the boundary; verified TLS
 * off-machine. Ids, codes and tCO₂e only — never a label, a quantity or money.
 *
 * The order after merge (ruled 27 Nov): this dry run → Francis approves → --commit → #676's load and re-point → v7:batch-attest → this
 * again over the jobs it listed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { v7FiguresClientFromEnv, v7RowFiguresClientFromEnv } from "../src/v7Drift";
import { parseV7BackfillApproved, runV7Backfill, v7BackfillCsv, v7BackfillLines, v7BackfillTotals } from "../src/v7ImportBackfill";
import { v7ImportViewSource } from "../src/v7ImportRefresh";
import { v7ImportViewPoolConfig } from "../src/v7ImportView";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const listOf = (value: string) => (existsSync(value) ? readFileSync(value, "utf8").split(/\r?\n/) : value.split(",")).map((item) => item.trim()).filter(Boolean);

async function main(): Promise<void> {
  const actorId = argument("--as");
  if (!actorId) throw new Error("--as <the Admin's user id> is required: the backfill runs as them, and they sign every audit event.");
  const reason = argument("--reason");
  if (!reason) throw new Error("--reason is required; it is recorded on every audit event.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const jobNumbers = argument("--jobs") ? listOf(argument("--jobs")!) : undefined;
  const report = argument("--report");
  const commit = process.argv.includes("--commit");
  const approvedPath = argument("--approved");
  const approved = approvedPath ? parseV7BackfillApproved(readFileSync(approvedPath, "utf8")) : undefined;
  const view = v7ImportViewPoolConfig();
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nThe reviewed backfill (R2) for ${organisationId} — ${commit ? "COMMIT: the approved jobs only, job by job" : "dry run: every job's whole act, rolled back"}`);
  log(`  connection: ${tls.description} · as ${actorId}${jobNumbers ? ` · ${jobNumbers.length} job(s) named` : ""}${approved ? ` · ${approved.size} approved` : ""}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-import-backfill" });
  const viewPool = new Pool(view);
  try {
    const result = await runV7Backfill(pool, {
      organisationId, actorId, reason, commit, source: v7ImportViewSource(viewPool), rowFigures: v7RowFiguresClientFromEnv(), figures: v7FiguresClientFromEnv(),
      ...(jobNumbers ? { jobNumbers } : {}), ...(approved ? { approved } : {}),
      onJob: (job) => { for (const line of v7BackfillLines(job)) log(line); },
    });
    if (report) writeFileSync(report, v7BackfillCsv(result.jobs));
    log("\nTotals:");
    for (const row of v7BackfillTotals(result.jobs)) log(`  ${row.label}: ${row.jobs}`);
    log(`  jobs: ${result.jobs.length} · audit events ${result.auditEvents}${result.stopped === "source-unresponsive" ? " · STOPPED: the previous system stopped answering" : ""}`);
    if (!commit) log("\nDry run complete: nothing written. Approve the list, then --commit --jobs <approved> --approved <the CSV>.");
    else log("\nWritten rows are back at pending: re-attest with v7:batch-attest.");
  } finally {
    await pool.end();
    await viewPool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-import-backfill failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
