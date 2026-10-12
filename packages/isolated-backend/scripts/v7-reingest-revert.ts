/**
 * Revert one v7 re-ingest run (RULING-v7-reingest-row-protection, disposition step 2): `v7.reingest.revert`, as merged in #467 —
 * the run's rows found by their link, all or nothing.
 *
 *   npm run v7:reingest:revert -w @nzi/isolated-backend -- --job <jobId> --run <runId> --reason "<why>" [--organisation <id>] [--commit]
 *
 * A dry run unless `--commit`, and a dry run is the whole revert, its post-condition included, rolled back: nothing is written.
 * It prints the job's counts before and after (the after read inside the transaction). Revert only. Reads and writes only the
 * console (staging). Fail-closed on the boundary; verified TLS off-machine. Prints counts only — no figures, no client data.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { runV7ReingestRevert, type V7ReingestJobCounts } from "../src/v7ReingestRevertRun";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const counts = (c: V7ReingestJobCounts) =>
  `linked live rows ${c.linkedLiveOn} on of ${c.linkedLiveRows} · v7 rows ${c.v7On} on of ${c.v7Rows} · run ${c.runStatus ?? "not found"}`;

async function main(): Promise<void> {
  const jobId = argument("--job"), runId = argument("--run"), reason = argument("--reason");
  if (!jobId || !runId || !reason?.trim()) throw new Error("--job <jobId>, --run <runId> and --reason \"<why>\" are required.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 re-ingest revert of ${runId} on ${jobId} for ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole revert, rolled back"}`);
  log(`  connection: ${tls.description}`);
  log(`  as policy:v7-reingest (system) · reason: ${reason.trim()}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-reingest-revert" });
  try {
    const report = await runV7ReingestRevert(pool, { organisationId, jobId, runId, reason, commit });
    log(`\n${commit ? "Reverted" : "Would revert"} — post-condition met (every linked live row off, every one of the run's v7 rows on)`);
    log(`  live rows switched off ${report.liveRowsSwitchedOff} · v7 rows switched on ${report.v7RowsSwitchedOn}`);
    log(`  before: ${counts(report.before)}`);
    log(`  after:  ${counts(report.after)}${commit ? "" : "  (read inside the transaction, then rolled back)"}`);
    if (!commit) log("\nDry run complete: nothing written. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-reingest-revert failed: ${error instanceof Error ? `${error.message}${"issues" in error ? ` ${JSON.stringify((error as { issues: unknown }).issues)}` : ""}` : String(error)}\n`);
  process.exitCode = 1;
});
