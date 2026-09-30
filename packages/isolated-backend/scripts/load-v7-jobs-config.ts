/**
 * Reconcile v7's jobs configuration into the console (admin Phase C4) — VAT rates, milestone templates and their items,
 * job types, job file types.
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-jobs-config --tables <the tables> --file C:/v7-extract-jobs-config/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-jobs-config/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-jobs-config --tables <the tables>
 *   npm run load:v7-jobs-config -- C:/v7-extract-jobs-config [--organisation <id>] [--commit]
 *
 * The tables: vat_rates_lookup, milestone_templates, milestone_template_items, job_template_milestone_completions,
 * job_types, job_file_types_lookup — and, for C5 on the same extract, jobs and job_plan (ruled plan §4.4). This load
 * reads only its own six. None of them holds personal data; the completions are read for their job and item ids only.
 *
 * A dry run unless `--commit`, and a dry run is the load rolled back. Per entity it reports inserted, stamped by natural
 * key, updated from v7 (R4), unchanged; R4 conflicts; seeded-only rows (reported, never archived); v7's counts against
 * the console's; value-for-value differences; and notes (defaults, VAT links, the items beyond the third). An entity
 * the plan refuses (more than one default, or an inactive one — Q6) is named, and nothing of it is written.
 * Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7JobsConfig, planV7JobsConfig, V7_JOBS_CONFIG_TABLES } from "../src/v7JobsConfigLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-jobs-config <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: V7_JOBS_CONFIG_TABLES });
  log(`\nv7 jobs configuration into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7JobsConfig(read.extract);
  log(`  v7: VAT rates ${plan.vatRates.values.length} · milestone templates ${plan.templates.values.length} · job types ${plan.jobTypes.values.length} · file types ${plan.fileTypes.values.length}`);
  if (plan.skipped.length) {
    log(`  left out (${plan.skipped.length}):`);
    for (const skip of plan.skipped) log(`      ${skip.table} ${skip.legacyDbId}: ${skip.reason}`);
  }
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-jobs-config-load" });
  try {
    const outcome = await loadV7JobsConfig(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    let problems = 0;
    for (const entity of outcome.entities) {
      log(`\n  ${entity.entity}`);
      if (entity.refused) { log(`    REFUSED — ${entity.refused}`); problems += 1; continue; }
      if (entity.failed) { log(`    FAILED — nothing of this entity was written: ${entity.failed}`); problems += 1; continue; }
      log(`    +${entity.inserted} inserted · ${entity.stamped} matched by key and stamped · ${entity.updated} updated from v7 (R4) · =${entity.unchanged} unchanged`);
      const p = entity.parity;
      const match = p.v7Active === p.consoleActive && p.v7Inactive === p.consoleInactive;
      log(`    parity: v7 ${p.v7Active} active / ${p.v7Inactive} inactive · console (v7-identified) ${p.consoleActive} / ${p.consoleInactive}${match ? " — match" : " — DIFFER"}`);
      if (!match) problems += 1;
      for (const difference of entity.valueDifferences) { log(`    VALUE DIFFERS ${difference}`); problems += 1; }
      if (entity.seededOnly.length) log(`    here, not in v7 — reported, not archived (${entity.seededOnly.length}): ${entity.seededOnly.join("; ")}`);
      for (const note of entity.notes) log(`    note: ${note}`);
      for (const conflict of entity.conflicts) { log(`    REFUSED (R4) ${conflict}`); problems += 1; }
    }
    if (problems) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-jobs-config failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
