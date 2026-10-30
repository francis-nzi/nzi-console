/**
 * The governed re-point of the four stray 2019 diesel-van rows (J000724–J000727, ruled 30 Oct 2026): each moves to its own reporting
 * year's edition of the same factor id, is recalculated, and is re-attested by the person running this.
 *
 *   SEED_ACTOR_ID=francis npm run v7:repoint-stray-2019 -w @nzi/isolated-backend -- --reason "<why>" [--report <dir>] \
 *       [--organisation <id>] [--commit]
 *
 * SEED_ACTOR_ID is the PERSON (an active member whose role holds snapshot.review): the re-attest and the audit events record them.
 * A dry run unless `--commit`, and a dry run is every job's whole act, rolled back — its report is the correction report for sign-off.
 * Each job is its own transaction; a re-run finds the row already moved and does nothing. Runs on the app role (withTenantWrite).
 * Fail-closed on the boundary; verified TLS off-machine. The report names jobs, row ids, datasets and emission figures — no client name.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { repointStrayRows, type StrayRepointRow } from "../src/v7StrayRepoint";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const fixed = (value: number | null, places: number) => (value === null ? "" : value.toFixed(places));
const signed = (value: number | null) => (value === null ? "" : `${value >= 0 ? "+" : ""}${value.toFixed(4)}`);
const pct = (row: StrayRepointRow) => (row.deltaTco2e === null || !row.jobTotalBefore ? "" : `${((row.deltaTco2e / row.jobTotalBefore) * 100).toFixed(3)}%`);

async function main(): Promise<void> {
  const actorId = process.env.SEED_ACTOR_ID;
  if (!actorId) throw new Error("SEED_ACTOR_ID must name the person re-attesting; the approvals and the audit record them.");
  const reason = argument("--reason");
  if (!reason) throw new Error("--reason is required; it is recorded on the re-attest and every audit event.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const reportDir = argument("--report");
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 stray-row re-point for ${organisationId} — ${commit ? "COMMIT, job by job" : "dry run: every job's whole act, rolled back"}`);
  log(`  connection: ${tls.description} · re-attesting as ${actorId}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-repoint-stray-2019" });
  try {
    const report = await repointStrayRows(pool, { organisationId, actorId, reason, commit });
    const header = "row_id,job,status,old_dataset,old_factor_value,new_dataset,new_factor_value,quantity,unit,old_tco2e,new_tco2e,delta_tco2e,job_total_before,job_total_after,delta_pct_of_job,reattested_rows,selection_removed,refusal_codes";
    const lines = [header];
    for (const row of report.rows) {
      lines.push([row.rowId, row.jobNumber, row.status, row.fromDataset, row.oldFactorValue ?? "", row.toDataset, row.newFactorValue ?? "", row.quantity ?? "", row.unit ?? "",
        fixed(row.oldTco2e, 6), fixed(row.newTco2e, 6), fixed(row.deltaTco2e, 6), fixed(row.jobTotalBefore, 6), fixed(row.jobTotalAfter, 6), pct(row), row.attestedRows, row.selectionRemoved, row.codes.join(" ")].join(","));
      log(`  ${row.jobNumber} ${row.rowId}: ${row.status}${row.codes.length ? ` — ${row.codes.join(" ")}` : ""}`);
      if (row.status !== "REFUSED") log(`      ${row.fromDataset} ${row.oldFactorValue} → ${row.toDataset} ${row.newFactorValue} · ${row.quantity} ${row.unit} · ${fixed(row.oldTco2e, 4)} → ${fixed(row.newTco2e, 4)} t (${signed(row.deltaTco2e)}; ${pct(row) || "n/a"} of the job) · re-attested ${row.attestedRows}${row.selectionRemoved ? " · 2019 selection removed" : ""}`);
    }
    const moved = report.rows.filter((row) => row.status === "REPOINTED");
    const delta = moved.reduce((sum, row) => sum + (row.deltaTco2e ?? 0), 0);
    if (reportDir) {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, "stray-repoint.csv"), `${lines.join("\n")}\n`);
      const md = ["# Correction report — the four stray 2019 diesel-van rows", "",
        `${commit ? "COMMITTED" : "DRY RUN (nothing written)"} · actor ${actorId} · ${organisationId}`, "",
        "| Row | Job | Old dataset · factor value | New dataset · factor value | Qty (unit) | Old tCO₂e | New tCO₂e | Δ tCO₂e | Δ % of job | Status |", "|---|---|---|---|---|---|---|---|---|---|",
        ...report.rows.map((row) => `| ${row.rowId} | ${row.jobNumber} | ${row.fromDataset} · ${row.oldFactorValue ?? "—"} | ${row.toDataset} · ${row.newFactorValue ?? "—"} | ${row.quantity ?? "—"} (${row.unit ?? "—"}) | ${fixed(row.oldTco2e, 4)} | ${fixed(row.newTco2e, 4)} | ${signed(row.deltaTco2e)} | ${pct(row) || "—"} | ${row.status}${row.codes.length ? ` ${row.codes.join(" ")}` : ""} |`),
        "", `Net Δ over the four rows: ${signed(delta)} tCO₂e.`, ""].join("\n");
      writeFileSync(join(reportDir, "stray-repoint.md"), md);
    }
    log(`\n${commit ? "Re-pointed" : "Would re-point"} ${moved.length} row(s); net Δ ${signed(delta)} tCO₂e · audit events ${report.auditEvents}${commit ? "" : " (rolled back)"}`);
    log(`  already re-pointed: ${report.rows.filter((row) => row.status === "ALREADY_REPOINTED").length} · refused: ${report.rows.filter((row) => row.status === "REFUSED").length}`);
    if (!commit) log("\nDry run complete: nothing written. Re-run with --commit to write.");
    if (report.rows.some((row) => row.status === "REFUSED")) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-repoint-stray-2019 failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
