/**
 * The governed correction of v7's `uk-ghg-gb-2019` to the real DESNZ 2019 conversion factors (RULING 30 Oct 2026): factor values corrected in
 * place on the existing ids, the rows that use a changed factor recalculated, and re-attested by the person running this.
 *
 *   SEED_ACTOR_ID=francis npm run v7:correct-desnz-2019 -w @nzi/isolated-backend -- --plan-only --report <dir>
 *   SEED_ACTOR_ID=francis npm run v7:correct-desnz-2019 -w @nzi/isolated-backend -- --reason "<why>" --report <dir> [--expect-sha <plan sha>]
 *   SEED_ACTOR_ID=francis npm run v7:correct-desnz-2019 -w @nzi/isolated-backend -- --reason "<why>" --report <dir> \
 *       --expect-sha <signed plan sha> [--acknowledge-flagged <hash>] --commit
 *
 * `--plan-only` reads, writes nothing, and produces the correction report (the artefact that is signed). The default is a dry run: the whole
 * act — values, recalculation, the re-attest preview, the audit — rolled back; its report adds the per-row emission deltas and the flagged
 * v7-delta set with its hash. `--commit` needs `--expect-sha` (the signed plan) and, when rows are flagged, `--acknowledge-flagged` (the hash
 * of the set that was reviewed). Runs on the app role (withTenantWrite). Fail-closed on the boundary; verified TLS off-machine.
 * The reports name jobs, row ids, factor ids and emission figures — no client name, no money.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { correctionCsv, correctionMarkdown, parseFlatFile, type FlatDocument } from "../src/v7Desnz2019";
import { correctDesnz2019, planFromDatabase } from "../src/v7Desnz2019Apply";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const fixed = (value: number | null, places: number) => (value === null ? "" : value.toFixed(places));
const signed = (value: number | null) => (value === null ? "" : `${value >= 0 ? "+" : ""}${value.toFixed(4)}`);

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const flat = parseFlatFile(JSON.parse(readFileSync(join(here, "..", "data", "desnz-2019", "factors-by-category-2019.json"), "utf8")) as FlatDocument);
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const reportDir = argument("--report");
  const planOnly = process.argv.includes("--plan-only");
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nDESNZ 2019 dataset correction for ${organisationId} — ${planOnly ? "plan only (read-only)" : commit ? "COMMIT" : "dry run: the whole act, rolled back"}`);
  log(`  connection: ${tls.description} · flat file ${flat.source.file} (${flat.source.sha256.slice(0, 12)}…)`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-desnz-2019" });
  try {
    const write = (name: string, text: string) => { if (reportDir) { mkdirSync(reportDir, { recursive: true }); writeFileSync(join(reportDir, name), text); } };
    if (planOnly) {
      const { plan, consumers } = await planFromDatabase(pool, organisationId, flat);
      write("desnz-2019-correction.csv", correctionCsv(plan));
      write("desnz-2019-correction.md", correctionMarkdown(plan, flat, { generatedFor: "Plan only — read-only, nothing written", consumers }));
      log(`  plan sha256 ${plan.sha256}`);
      log(`  ${plan.lines.length} stored · ${plan.counts.changed} change · ${plan.counts.alreadyEqual} equal · ${plan.counts.UNMATCHED} unmatched · ${plan.counts.AMBIGUOUS} ambiguous · ${plan.counts.BLANK_IN_SOURCE} blank in source · ${plan.counts.NZI_CUSTOM} NZI-defined`);
      log(`  in use ${plan.counts.inUse} (${plan.counts.inUseChanged} change) · consumers: ${consumers.join(", ") || "none"}`);
      return;
    }
    const actorId = process.env.SEED_ACTOR_ID;
    if (!actorId) throw new Error("SEED_ACTOR_ID must name the person re-attesting; the approvals and the audit record them.");
    const reason = argument("--reason");
    if (!reason) throw new Error("--reason is required; it is recorded on the re-attest and the audit event.");
    const report = await correctDesnz2019(pool, { organisationId, actorId, reason, commit, flat, expectedPlanSha: argument("--expect-sha"), acknowledgeFlagged: argument("--acknowledge-flagged") });
    write("desnz-2019-correction.csv", correctionCsv(report.plan));
    write("desnz-2019-correction.md", correctionMarkdown(report.plan, flat, { generatedFor: commit ? "COMMITTED" : "Dry run — rolled back", consumers: report.consumers }));
    const header = "job,row_id,dataset_id,factor_id,quantity,unit,old_tco2e,new_tco2e,delta_tco2e";
    write("desnz-2019-rows.csv", [header, ...report.rows.map((row) => [row.jobNumber, row.rowId, row.datasetId, row.factorId, row.quantity ?? "", row.unit ?? "", fixed(row.oldTco2e, 6), fixed(row.newTco2e, 6), fixed(row.deltaTco2e, 6)].join(","))].join("\n") + "\n");
    log(`  plan sha256 ${report.plan.sha256}`);
    log(`\n${commit ? "Corrected" : "Would correct"} ${report.factorsUpdated} factor values; ${report.rows.length} scope row(s) recalculated on ${report.consumers.join(", ")}`);
    for (const row of report.rows) log(`  ${row.jobNumber} ${row.rowId} ${row.factorId}: ${fixed(row.oldTco2e, 4)} → ${fixed(row.newTco2e, 4)} t (${signed(row.deltaTco2e)})`);
    for (const total of report.jobTotals) log(`  ${total.jobNumber} total ${fixed(total.before, 4)} → ${fixed(total.after, 4)} t (${signed(total.after - total.before)})`);
    log(`  flagged emission deltas against v7: ${report.flaggedDeltas.length}${report.flaggedSha ? ` — hash ${report.flaggedSha} (pass --acknowledge-flagged ${report.flaggedSha} to commit)` : ""}`);
    log(`  re-attested rows ${report.attestedRows} · audit events ${report.auditEvents}${commit ? "" : " (rolled back)"}`);
    if (!commit) log("\nDry run complete: nothing written. Re-run with --commit (and --expect-sha) to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-correct-desnz-2019 failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
