/**
 * Reconcile v7's custom field definitions into the console (admin Phase F3; ruled plan `phaseF-comms-crm-plan.md`,
 * F-Q5). Definitions only — v7's values are the entity workstreams' to carry (docs/CUSTOM_FIELD_VALUES_CONTRACT.md).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-custom-fields --tables custom_field_definitions --file C:/v7-extract-custom-fields/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-custom-fields/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-custom-fields --tables custom_field_definitions
 *   npm run load:v7-custom-fields -- C:/v7-extract-custom-fields [--organisation <id>] [--commit]
 *
 * v7's definitions are global; they load into the organisation named. They hold no personal data, so the report can go
 * to `_handoff`. A dry run unless `--commit`, and a dry run is the load rolled back. Delete the extract once committed
 * and verified. Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7CustomFields, planV7CustomFields, V7_CUSTOM_FIELD_TABLES } from "../src/v7CustomFieldsLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-custom-fields <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: V7_CUSTOM_FIELD_TABLES });
  log(`\nv7 custom field definitions into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7CustomFields(read.extract);
  log(`  v7: ${read.extract.custom_field_definitions?.length ?? 0} definition(s) → ${plan.values.length} to reconcile: ${plan.values.map((value) => `${value.entityType}.${value.key} (${value.type})`).join(", ")}`);
  if (plan.skipped.length) {
    log(`  left out (${plan.skipped.length}):`);
    for (const skip of plan.skipped) log(`      custom_field_definitions ${skip.legacyDbId}: ${skip.reason}`);
  }
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-custom-fields-load" });
  try {
    const outcome = await loadV7CustomFields(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    let problems = 0;
    log(`  +${outcome.inserted} inserted · ${outcome.stamped} matched by entity and key and stamped · ${outcome.updated} updated from v7 (R4) · =${outcome.unchanged} unchanged`);
    const p = outcome.parity;
    const match = p.v7Active === p.consoleActive && p.v7Inactive === p.consoleInactive;
    log(`  parity: v7 ${p.v7Active} active / ${p.v7Inactive} inactive · console (v7-identified) ${p.consoleActive} / ${p.consoleInactive}${match ? " — match" : " — DIFFER"}`);
    if (!match && commit) problems += 1;
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
  process.stderr.write(`\nload-v7-custom-fields failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
