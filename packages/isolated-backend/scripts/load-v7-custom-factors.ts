/**
 * V7's client custom factors into the console's client factors, one per V7 factor (cause 7; PLAN-v7-client-custom-factors §3; 0240).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-cf --tables custom_factors,custom_factor_year_values,job_custom_factors,job_custom_factor_year_values --file C:/v7-extract-cf/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-cf/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-cf --tables custom_factors,custom_factor_year_values,job_custom_factors,job_custom_factor_year_values
 *   npm run load:v7-custom-factors -w @nzi/isolated-backend -- C:/v7-extract-cf [--organisation <id>] [--commit]
 *
 * No personal data: ids, values, units, scope, category, country and V7's report label. A dry run unless `--commit`, and a dry run is
 * the load rolled back; its counts are the staging dry run. Fail-closed on the boundary; verified TLS off-machine. Delete the extract
 * directory once the load is committed and verified. The re-point of the re-ingested rows onto these factors is its own step:
 * `npm run v7:repoint-custom-factors`.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7CustomFactors, planV7CustomFactors, V7_CUSTOM_FACTOR_TABLES } from "../src/v7CustomFactorsLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-custom-factors <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: V7_CUSTOM_FACTOR_TABLES });
  log(`\nv7 custom factors into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7CustomFactors(read.extract);
  log(`  v7: ${read.extract.custom_factors?.length ?? 0} custom factor(s), ${read.extract.job_custom_factors?.length ?? 0} job-only factor(s) → ${plan.factors.length} to load`);
  if (plan.skipped.length) {
    log(`  left out (${plan.skipped.length}):`);
    for (const skip of plan.skipped) log(`      ${skip.legacyDbId}: ${skip.reason}`);
  }
  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-custom-factors-load" });
  try {
    const outcome = await loadV7CustomFactors(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    log(`  +${outcome.inserted} inserted · ${outcome.updated} updated (a version bump each) · =${outcome.unchanged} unchanged`);
    log(`  custom ${outcome.byFamily.custom} · job-only ${outcome.byFamily["job-only"]} · organisation-level ${outcome.organisationLevel} · year values ${outcome.yearValues}`);
    if (outcome.skipped.length) {
      log(`  left out at load (${outcome.skipped.length}):`);
      for (const skip of outcome.skipped) log(`      ${skip.legacyDbId}: ${skip.reason}`);
    }
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-custom-factors failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
