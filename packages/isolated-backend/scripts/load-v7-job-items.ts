/**
 * Reconcile v7's service catalogue into the console (admin Phase E2; ruled plan `phaseE-commercial-catalogue-plan.md`
 * E-Q4/E-Q8/E-Q9).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-job-items --tables job_items --file C:/v7-extract-job-items/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-job-items/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-job-items --tables job_items
 *   npm run load:v7-job-items -- C:/v7-extract-job-items [--organisation <id>] [--commit]
 *
 * Run after `load:v7-lookups` (categories, units), `load:v7-jobs-config` (VAT rates) and 0145 (currencies): the items'
 * references resolve against what those loaded. `job_items` holds no personal data, but **its cost and sell are
 * commercially sensitive** (E-Q8): this report says how many items are priced and which differ from v7 — never an
 * amount — so it can go to `_handoff`. Delete the extract directory once the load is committed and verified: it holds
 * the amounts.
 *
 * A dry run unless `--commit`, and a dry run is the load rolled back. Fail-closed on the boundary; verified TLS
 * off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7JobItems, planV7JobItems, V7_JOB_ITEM_TABLES } from "../src/v7JobItemsLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-job-items <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: V7_JOB_ITEM_TABLES });
  log(`\nv7 service catalogue into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7JobItems(read.extract);
  log(`  v7: ${read.extract.job_items?.length ?? 0} item(s) → ${plan.values.length} to reconcile: ${plan.values.map((value) => value.code).join(", ")}`);
  if (plan.skipped.length) {
    log(`  left out (${plan.skipped.length}):`);
    for (const skip of plan.skipped) log(`      job_items ${skip.legacyDbId}: ${skip.reason}`);
  }
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-job-items-load" });
  try {
    const outcome = await loadV7JobItems(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    let problems = 0;
    log(`  +${outcome.inserted} inserted · ${outcome.stamped} matched by code and stamped · ${outcome.updated} updated from v7 (R4) · =${outcome.unchanged} unchanged`);
    const p = outcome.parity;
    const match = p.v7Active === p.consoleActive && p.v7Inactive === p.consoleInactive;
    log(`  parity: v7 ${p.v7Active} active / ${p.v7Inactive} inactive · console (v7-identified) ${p.consoleActive} / ${p.consoleInactive}${match ? " — match" : " — DIFFER"}`);
    if (!match && commit) problems += 1;
    log(`  priced: ${outcome.priced} v7-identified item(s) carry a sell price (amounts are not printed — E-Q8)`);
    for (const difference of outcome.amountDifferences) { log(`  AMOUNTS DIFFER ${difference}`); problems += 1; }
    if (outcome.hereOnly.length) log(`  here, not in v7 — reported, not deactivated (${outcome.hereOnly.length}): ${outcome.hereOnly.join(", ")}`);
    for (const note of outcome.notes) log(`  note: ${note}`);
    for (const refusal of outcome.refused) { log(`  REFUSED ${refusal}`); problems += 1; }
    if (problems) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-job-items failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
