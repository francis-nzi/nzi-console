/**
 * Correct the 11 stale migrated quantities (RULING 29 Oct 2026): `migrated_record.qty` := the sum of the row's months, for the
 * ruled rows only, through the sanctioned immutability bypass (0133) in one reviewed transaction.
 *
 *   npm run v7:correct-migrated-qty -w @nzi/isolated-backend -- [--organisation <id>] [--commit]
 *
 * SEED_ACTOR_ID names who is acting (the audit events record it). A dry run unless `--commit`, and a dry run is the whole
 * correction — the guards, the trigger bypass, the update, the post-conditions, the audit rows — rolled back: nothing is written.
 * It refuses if any of the jobs has a completed re-ingest run, or if the book-wide scan does not return exactly the ruled rows.
 * Runs on the owner (login) role: the trigger DDL needs the table owner. Fail-closed on the boundary; verified TLS off-machine.
 * Prints ids and counts only — no figures.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { correctStaleMigratedQty } from "../src/v7MigratedQtyCorrection";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const actorId = process.env.SEED_ACTOR_ID;
  if (!actorId) throw new Error("SEED_ACTOR_ID must name who is running the correction; the audit events record it.");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nv7 migrated-quantity correction for ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole correction, rolled back"}`);
  log(`  connection: ${tls.description} · actor ${actorId}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 1, application_name: "nzi-v7-migrated-qty-correction" });
  try {
    const report = await correctStaleMigratedQty(pool, { organisationId, actorId, commit });
    log(`\n${commit ? "Corrected" : "Would correct"} ${report.corrected} rows on ${report.jobs} jobs — every one now equals its months sum; trigger enabled again: ${report.triggerEnabledAfter}`);
    log(`  audit events ${report.auditEvents}${commit ? "" : " (rolled back)"}`);
    if (report.withinRounding.length) log(`  differs within rounding — not in the ruled set, not touched: ${report.withinRounding.join(", ")}`);
    if (report.disabledMismatches.length) log(`  disabled rows that differ (never in v7's totals) — not touched: ${report.disabledMismatches.join(", ")}`);
    if (!commit) log("\nDry run complete: nothing written. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nv7-correct-migrated-qty failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
