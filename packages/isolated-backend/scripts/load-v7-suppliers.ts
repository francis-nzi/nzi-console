/**
 * Reconcile v7's suppliers, their contacts and their rate card into the console (admin Phase E4; ruled plan
 * `phaseE-commercial-catalogue-plan.md` E-Q6–E-Q9).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-suppliers --tables suppliers,supplier_service_items --file C:/v7-extract-suppliers/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-suppliers/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-suppliers --tables suppliers,supplier_service_items
 *   npm run load:v7-suppliers -- C:/v7-extract-suppliers [--organisation <id>] [--commit]
 *
 * Run after `load:v7-lookups` (units), `load:v7-jobs-config` (VAT rates) and 0145 (currencies). **The extract holds
 * personal data** — each supplier's contact name, email and phone (never v7's address or notes: the contract does not
 * name them) — so it stays outside the repository and `_handoff`, and is deleted once the load is committed and
 * verified. The contacts are **sealed on load** (E-Q7). **The report names nobody and prints no rate**: suppliers and
 * lines by v7 id, rates as a count and a list of which differ (E-Q8) — so the report can go to `_handoff`.
 *
 * A dry run unless `--commit`, and a dry run is the load rolled back. Sealing keys come from the environment, as every
 * sealed write does. Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7Suppliers, planV7Suppliers, V7_SUPPLIER_TABLES } from "../src/v7SuppliersLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-suppliers <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const keys = resolveSealingKeys();
  const read = readV7Extract(directory, { tables: V7_SUPPLIER_TABLES });
  log(`\nv7 suppliers and rate card into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7Suppliers(read.extract);
  log(`  v7: ${read.extract.suppliers?.length ?? 0} supplier(s) → ${plan.suppliers.length} to reconcile, ${plan.suppliers.filter((supplier) => supplier.contact).length} with a contact;`
    + ` ${read.extract.supplier_service_items?.length ?? 0} rate-card line(s) → ${plan.items.length}`);
  if (plan.skipped.length) {
    log(`  left out (${plan.skipped.length}):`);
    for (const skip of plan.skipped) log(`      ${skip.table} ${skip.legacyDbId}: ${skip.reason}`);
  }
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-suppliers-load" });
  try {
    const outcome = await loadV7Suppliers(pool, organisationId, plan, { commit, keys });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    let problems = 0;
    for (const [label, t] of [["suppliers", outcome.suppliers], ["contacts (sealed)", outcome.contacts], ["rate-card lines", outcome.items]] as const) {
      log(`  ${label}: +${t.inserted} inserted · ${t.stamped} matched and stamped · ${t.updated} updated from v7 (R4) · =${t.unchanged} unchanged`);
    }
    const p = outcome.parity;
    const match = p.v7Active === p.consoleActive && p.v7Inactive === p.consoleInactive;
    log(`  parity (suppliers): v7 ${p.v7Active} active / ${p.v7Inactive} inactive · console (v7-identified) ${p.consoleActive} / ${p.consoleInactive}${match ? " — match" : " — DIFFER"}`);
    if (!match && commit) problems += 1;
    log(`  rated: ${outcome.rated} v7-identified line(s) carry an agreed rate (rates are not printed — E-Q8)`);
    for (const difference of outcome.rateDifferences) { log(`  RATE DIFFERS ${difference}`); problems += 1; }
    const h = outcome.hereOnly;
    if (h.suppliers + h.contacts + h.items) log(`  here, not in v7 — reported, not deactivated: ${h.suppliers} supplier(s), ${h.contacts} contact(s), ${h.items} line(s)`);
    for (const note of outcome.notes) log(`  note: ${note}`);
    for (const refusal of outcome.refused) { log(`  REFUSED ${refusal}`); problems += 1; }
    if (problems) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-suppliers failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
