/**
 * Reconcile v7's job-type templates into the console (admin Phase E3; ruled plan `phaseE-commercial-catalogue-plan.md`
 * E-Q5/E-Q10) — which catalogue items each job type starts with.
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-job-type-items --tables job_type_items --file C:/v7-extract-job-type-items/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-job-type-items/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-job-type-items --tables job_type_items
 *   npm run load:v7-job-type-items -- C:/v7-extract-job-type-items [--organisation <id>] [--commit]
 *
 * Run after `load:v7-jobs-config` (job types) and `load:v7-job-items` (the catalogue): each row resolves its job type and
 * item by their v7 identities, and one whose type or item is not loaded is reported, never guessed. No personal data and
 * no amounts. A dry run unless `--commit`, and a dry run is the load rolled back. Fail-closed on the boundary; verified
 * TLS off-machine. Delete the extract directory once the load is committed and verified.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7JobTypeItems, planV7JobTypeItems, V7_JOB_TYPE_ITEM_TABLES } from "../src/v7JobTypeItemsLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-job-type-items <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: V7_JOB_TYPE_ITEM_TABLES });
  log(`\nv7 job-type templates into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7JobTypeItems(read.extract);
  log(`  v7: ${read.extract.job_type_items?.length ?? 0} template row(s) → ${plan.values.length} to reconcile`);
  if (plan.skipped.length) {
    log(`  left out (${plan.skipped.length}):`);
    for (const skip of plan.skipped) log(`      job_type_items ${skip.legacyDbId}: ${skip.reason}`);
  }
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-job-type-items-load" });
  try {
    const outcome = await loadV7JobTypeItems(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    let problems = 0;
    log(`  +${outcome.inserted} inserted · ${outcome.stamped} matched by pair and stamped · ${outcome.updated} updated from v7 (R4) · =${outcome.unchanged} unchanged`);
    for (const row of outcome.unresolved) { log(`  UNRESOLVED ${row}`); problems += 1; }
    if (outcome.hereOnly.length) log(`  here, not in v7 — reported, not dropped (${outcome.hereOnly.length}): ${outcome.hereOnly.join("; ")}`);
    for (const note of outcome.notes) log(`  note: ${note}`);
    for (const conflict of outcome.conflicts) { log(`  REFUSED (R4) ${conflict}`); problems += 1; }
    if (problems) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-job-type-items failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
