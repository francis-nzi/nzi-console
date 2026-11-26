/**
 * Addendum A (BRIEF-baseline-year-and-pending-targets, ruled 25 Nov 2026): carry the values entered on jobs' own "Reduction
 * pathway target" onto their client — the client's baseline is the only one — and list every conflict for review.
 *
 *   npx tsx scripts/carry-job-pathway-targets.ts [--organisation <id>] [--commit]
 *
 * A dry run unless `--commit`, and a dry run is the whole run, rolled back. Writes only through client.update and
 * client.targets.set. The report names clients (businesses) and job numbers, years, percentages and baseline totals — no person.
 * Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { carryJobPathwayTargets } from "../src/jobPathwayCarry";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nJob pathway targets → client, for ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole run, rolled back"}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-pathway-carry" });
  try {
    const outcome = await carryJobPathwayTargets(pool, organisationId, { commit });
    log(`  run ${outcome.runId}`);
    log(`\nCarried (${outcome.carried.length} clients):`);
    for (const entry of outcome.carried) log(`  ${entry.clientName}: ${entry.items.map((item) => `${item.what} ${item.value} (from ${item.from})`).join(" · ")}`);
    log(`\nAgreed already (${outcome.agreed.length}):`);
    for (const entry of outcome.agreed) log(`  ${entry.clientName}: ${entry.what}`);
    log(`\nConflicts for review (${outcome.conflicts.length}):`);
    for (const entry of outcome.conflicts) log(`  ${entry.clientName}: ${entry.what} — client holds ${entry.client}; jobs ${entry.jobs}`);
    log(`\nRefused (${outcome.refused.length}):`);
    for (const entry of outcome.refused) log(`  ${entry.clientName}: ${entry.reason}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
