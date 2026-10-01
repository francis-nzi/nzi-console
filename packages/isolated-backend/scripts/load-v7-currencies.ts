/**
 * Consolidate v7's two currency tables into the console's currencies (admin Phase E1; ruled plan
 * `phaseE-commercial-catalogue-plan.md` §E1.2, E-Q1/E-Q2).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-currencies --tables currency_lookup,currencies_lookup --file C:/v7-extract-currencies/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-currencies/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-currencies --tables currency_lookup,currencies_lookup
 *   npm run load:v7-currencies -- C:/v7-extract-currencies [--organisation <id>] [--commit]
 *
 * Neither table holds personal data; `exchange_rate` is not extracted (E-Q1). A dry run unless `--commit`, and a dry run
 * is the load rolled back. It reports the consolidation (v7's "UAE" read as AED, codes left out), then inserted, stamped
 * onto 0145's rows, updated from v7 (R4) and unchanged; R4 conflicts; codes held here that v7 lacks (reported, never
 * deactivated); notes (defaults, names kept as edited here); and v7's counts against the console's. A v7 with more than
 * one default, or an inactive one, is refused whole. Fail-closed on the boundary; verified TLS off-machine. Delete the
 * extract directory once the load is committed and verified.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7Currencies, planV7Currencies, V7_CURRENCY_TABLES } from "../src/v7CurrenciesLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-currencies <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: V7_CURRENCY_TABLES });
  log(`\nv7 currencies into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7Currencies(read.extract);
  log(`  v7: ${read.extract.currency_lookup?.length ?? 0} currency_lookup row(s) + ${read.extract.currencies_lookup?.length ?? 0} currencies_lookup row(s) → ${plan.values.length} currencies: ${plan.values.map((value) => value.code).join(", ")}`);
  for (const correction of plan.corrections) log(`  corrected: ${correction}`);
  if (plan.skipped.length) {
    log(`  left out (${plan.skipped.length}):`);
    for (const skip of plan.skipped) log(`      ${skip.table} ${skip.code}: ${skip.reason}`);
  }
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-currencies-load" });
  try {
    const outcome = await loadV7Currencies(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    if (outcome.refused) { log(`  REFUSED — ${outcome.refused}`); process.exitCode = 1; return; }
    let problems = 0;
    log(`  +${outcome.inserted} inserted · ${outcome.stamped} matched by code and stamped · ${outcome.updated} updated from v7 (R4) · =${outcome.unchanged} unchanged`);
    const p = outcome.parity;
    const match = p.v7Active === p.consoleActive && p.v7Inactive === p.consoleInactive;
    log(`  parity: v7 ${p.v7Active} active / ${p.v7Inactive} inactive · console (v7-identified) ${p.consoleActive} / ${p.consoleInactive}${match ? " — match" : " — DIFFER"}`);
    if (!match && commit) problems += 1;
    if (outcome.hereOnly.length) log(`  here, not in v7 — reported, not deactivated (${outcome.hereOnly.length}): ${outcome.hereOnly.join(", ")}`);
    for (const note of outcome.notes) log(`  note: ${note}`);
    for (const conflict of outcome.conflicts) { log(`  REFUSED (R4) ${conflict}`); problems += 1; }
    if (problems) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-currencies failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
