/**
 * Reconcile v7's lookups into `reference_values` (admin Phase A3).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-lookups --tables <the twelve> --file C:/v7-extract-lookups/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-lookups/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-lookups --tables <the twelve>
 *   npm run load:v7-lookups -- C:/v7-extract-lookups [--organisation <id>] [--commit]
 *
 * The twelve: industries_lookup, referrals_lookup, portfolios_lookup, payment_terms_lookup, positions_lookup,
 * processes_lookup, client_teams_lookup, action_categories_lookup, governance_subjects_lookup, bd_bin_reasons_lookup,
 * uom_lookup, job_item_categories_lookup — none holds personal data.
 *
 * A dry run unless `--commit`, and a dry run is the load, per category, rolled back. Per category it reports: values
 * inserted, stamped onto an existing value by label (and of those, reinstated or deactivated as v7 has them), updated
 * from v7 (R4), unchanged; R4 conflicts by label; seeded values v7 lacks (reported, never archived — P6); v7's counts
 * against the console's; and, for portfolios, the owner links. Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7Lookups, planV7Lookups, V7_LOOKUP_TABLE_NAMES } from "../src/v7LookupLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-lookups <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: V7_LOOKUP_TABLE_NAMES });
  log(`\nv7 lookup reconcile into ${organisationId} — ${commit ? "COMMIT" : "dry run: each category loaded and rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7Lookups(read.extract);
  log(`  v7 values: ${plan.categories.map((c) => `${c.category} ${c.values.length}`).join(" · ")}`);
  if (plan.skipped.length) {
    log(`  left out (${plan.skipped.length}):`);
    for (const skip of plan.skipped) log(`      ${skip.table} ${skip.legacyDbId}: ${skip.reason}`);
  }
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-lookup-load" });
  try {
    const outcome = await loadV7Lookups(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    let problems = 0;
    for (const c of outcome.categories) {
      log(`\n  ${c.category}`);
      if (c.failed) { log(`    FAILED — nothing of this category was written: ${c.failed}`); problems += 1; continue; }
      log(`    +${c.inserted} inserted · ${c.stamped} matched by label and stamped (${c.reinstated} reinstated, ${c.deactivated} deactivated as v7 has them) · ${c.updated} updated from v7 (R4) · =${c.unchanged} unchanged`);
      log(`    parity: v7 ${c.parity.v7Active} active / ${c.parity.v7Inactive} inactive · console (v7-identified) ${c.parity.consoleActive} / ${c.parity.consoleInactive}${c.parity.v7Active === c.parity.consoleActive && c.parity.v7Inactive === c.parity.consoleInactive ? " — match" : " — DIFFER"}`);
      if (c.parity.v7Active !== c.parity.consoleActive || c.parity.v7Inactive !== c.parity.consoleInactive) problems += 1;
      if (c.seededOnly.length) log(`    seeded here, not in v7 — reported, not archived (${c.seededOnly.length}): ${c.seededOnly.join("; ")}`);
      for (const conflict of c.conflicts) { log(`    REFUSED (R4) ${conflict.label}: ${conflict.reason}`); problems += 1; }
      if (c.owners) {
        log(`    portfolio owners: +${c.owners.linked} linked · ${c.owners.updated} updated · =${c.owners.unchanged} unchanged`);
        for (const missing of c.owners.ownerNotImported) log(`      owner not in the console: ${missing}`);
        for (const conflict of c.owners.conflicts) { log(`      REFUSED (R4) ${conflict}`); problems += 1; }
      }
    }
    if (problems) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-lookups failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
