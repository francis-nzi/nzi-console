/**
 * The re-point of re-ingested rows from their one-per-row carried factors onto V7's own custom factors (cause 7;
 * PLAN-v7-client-custom-factors §4, D-2), after `load:v7-custom-factors`.
 *
 *   SEED_ACTOR_ID=francis npm run v7:repoint-custom-factors -w @nzi/isolated-backend -- --reason "<why>" [--jobs J000456,J000233] \
 *       [--report out.csv] [--organisation <id>] [--commit]
 *
 * SEED_ACTOR_ID is the PERSON (an active member whose role holds snapshot.review): the audit events record them. A dry run unless
 * `--commit`, and a dry run is every job's whole act, rolled back — its list is what a commit would do. Each job is its own
 * transaction; a row moves only if it reproduces (± 0.005 t), else it is listed and its carried factor stays; a re-run finds nothing
 * left to move. Moved rows go back to pending, as every recalculation does: re-attest with `v7:batch-attest`. Runs on the app role
 * (withTenantWrite). Fail-closed on the boundary; verified TLS off-machine. The report names jobs, row ids, factor ids and tCO₂e.
 */
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { repointCustomFactorRows } from "../src/v7CustomFactorRepoint";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const fixed = (value: number | null) => (value === null ? "" : value.toFixed(6));
const csv = (value: string | number | boolean | null) => { const cell = value === null ? "" : String(value); return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell; };

async function main(): Promise<void> {
  const actorId = process.env.SEED_ACTOR_ID;
  if (!actorId) throw new Error("SEED_ACTOR_ID must name the person re-pointing; the audit events record them.");
  const reason = argument("--reason");
  if (!reason) throw new Error("--reason is required; it is recorded on every audit event.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const jobs = argument("--jobs")?.split(",").map((job) => job.trim()).filter(Boolean);
  const reportPath = argument("--report");
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 custom-factor re-point for ${organisationId} — ${commit ? "COMMIT, job by job" : "dry run: every job's whole act, rolled back"}`);
  log(`  connection: ${tls.description} · as ${actorId}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-repoint-custom-factors" });
  try {
    const report = await repointCustomFactorRows(pool, { organisationId, actorId, reason, commit, ...(jobs ? { jobNumbers: jobs } : {}) });
    const lines = ["job,row_id,v7_row_id,custom_id,status,code,from_factor,to_factor,before_tco2e,after_tco2e,was_approved,job_issued"];
    let moved = 0, notMoved = 0, folded = 0, approvedReset = 0;
    for (const job of report.jobs) {
      const here = job.rows.filter((row) => row.status === "MOVED");
      moved += here.length; notMoved += job.rows.length - here.length; folded += job.folded.length; approvedReset += here.filter((row) => row.wasApproved).length;
      log(`  ${job.jobNumber ?? job.jobId}: ${here.length}/${job.rows.length} moved · ${job.folded.length} folded · total ${job.totals.beforeTco2e.toFixed(4)} → ${job.totals.afterTco2e.toFixed(4)} t${job.issued ? " · ISSUED (frozen; moved with the reason)" : ""}${job.refused ? ` · REFUSED ${job.refused}` : ""}`);
      for (const row of job.rows.filter((item) => item.status !== "MOVED")) log(`      not moved ${row.rowId} (${row.legacyCustomId ?? "no id"}): ${row.code}${row.afterTco2e !== null ? ` — ${fixed(row.beforeTco2e)} → ${fixed(row.afterTco2e)} t` : ""}`);
      for (const row of job.rows) lines.push([job.jobNumber, row.rowId, row.v7RowId, row.legacyCustomId, row.status, row.code, row.fromFactorId, row.toFactorId,
        fixed(row.beforeTco2e), fixed(row.afterTco2e), row.wasApproved, job.issued].map(csv).join(","));
    }
    if (reportPath) writeFileSync(reportPath, `${lines.join("\n")}\n`);
    log(`\n${commit ? "Moved" : "Would move"} ${moved} row(s) on ${report.jobs.length} job(s) · not moved ${notMoved} · carried factors folded ${folded} · approved rows back to pending ${approvedReset} · audit events ${report.auditEvents}`);
    if (!commit) log("\nDry run complete: nothing written. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-repoint-custom-factors failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
