/**
 * The governed batch attest over the committed v7 re-ingest runs: one person attests every run with no flagged emission delta,
 * in one reviewed act, through `scope.review.attest_reingest` (same bar: snapshot.review, a reason, D7.2 re-checked, each row its
 * own approval, the two record-of-account gaps resolved alongside).
 *
 *   npm run v7:batch-attest -w @nzi/isolated-backend -- --reason "<why>" [--jobs <J000052,… | file>] [--report <dir>] \
 *       [--organisation <id>] [--commit]
 *
 * SEED_ACTOR_ID is the PERSON attesting (an active member whose role holds snapshot.review); the approvals record them. A dry run
 * unless `--commit`, and a dry run is every run's whole act, rolled back. A run with a flagged emission delta, or a row that cannot
 * be attested, is skipped and stays a manual per-job attest. Each run is its own transaction; a re-run replays, never doubles.
 * Runs on the app role (withTenantWrite), not the owner. Fail-closed on the boundary; verified TLS off-machine.
 * Prints job numbers, run ids and counts only — never a label or a figure.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { batchAttestReingestRuns } from "../src/v7BatchAttest";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const listOf = (value: string) => (existsSync(value) ? readFileSync(value, "utf8").split(/\r?\n/) : value.split(",")).map((item) => item.trim()).filter(Boolean);

async function main(): Promise<void> {
  const actorId = process.env.SEED_ACTOR_ID;
  if (!actorId) throw new Error("SEED_ACTOR_ID must name the person attesting; the approvals record them.");
  const reason = argument("--reason");
  if (!reason) throw new Error("--reason is required; it is recorded on every approval.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const jobNumbers = argument("--jobs") ? listOf(argument("--jobs")!) : undefined;
  const reportDir = argument("--report");
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 batch attest for ${organisationId} — ${commit ? "COMMIT, run by run" : "dry run: every run's whole act, rolled back"}`);
  log(`  connection: ${tls.description} · attesting as ${actorId}${jobNumbers ? ` · ${jobNumbers.length} job(s) named` : " · every committed run"}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-batch-attest" });
  try {
    const report = await batchAttestReingestRuns(pool, { organisationId, actorId, reason, commit, jobNumbers });
    const lines = ["job,run_id,status,approved_rows,resolved_gaps,already_approved,rejected_excluded,flagged_deltas,blocked_rows,refusal_codes"];
    for (const run of report.runs) {
      lines.push([run.jobNumber, run.runId, run.status, run.approved, run.gapsResolved, run.skippedApproved, run.excludedRejected, run.flagged, run.blocked, run.codes.join(" ")].join(","));
      log(`  ${run.jobNumber}: ${run.status}${run.status === "ATTESTED" ? ` — ${run.approved} approved · ${run.gapsResolved} gaps resolved` : ""}`
        + `${run.flagged ? ` — ${run.flagged} flagged delta(s): a manual per-job attest` : ""}${run.blocked ? ` — ${run.blocked} row(s) cannot be attested` : ""}${run.codes.length ? ` — ${run.codes.join(" ")}` : ""}`);
    }
    if (reportDir) { mkdirSync(reportDir, { recursive: true }); writeFileSync(join(reportDir, "batch-attest.csv"), `${lines.join("\n")}\n`); }
    log(`\n${commit ? "Attested" : "Would attest"} ${report.tally.ATTESTED} run(s): ${report.approved} rows approved · ${report.gapsResolved} record-of-account gaps resolved`);
    log(`  skipped: ${report.tally.SKIPPED_FLAGGED} flagged · ${report.tally.SKIPPED_BLOCKED} blocked · ${report.tally.NOTHING_TO_ATTEST} nothing to attest · refused ${report.tally.REFUSED}`);
    log(`  audit events ${report.auditEvents}${commit ? "" : " (rolled back)"}`);
    if (!commit) log("\nDry run complete: nothing written. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-batch-attest failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
