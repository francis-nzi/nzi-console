/**
 * Data entry D6 (R1, R2a, R3) — clear the commuting and pre-D5 travel identifiers, once, behind the staging gate.
 *
 *   npm run clear:commuting-travel-identifiers -w @nzi/isolated-backend -- [--organisation <id>] [--travel-before <timestamp>] [--commit]
 *
 * Every commuting source and live 3.7 row loses the commuter's name and any registration (relabelled "Commuter n · mode" where the
 * label was the name); every travel source and live 3.6 row written before `--travel-before` (default: D5 A's merge — pass the D5 A
 * deploy time on staging) loses its "Traveller / trip ref" identifier. No figure moves. A dry run is the whole run, rolled back.
 * Output is counts only — never a name, a plate or a label. Re-running clears nothing.
 */
import { Pool } from "pg";
import { clearCommutingTravelIdentifiers, D5_TRAVEL_CUTOFF } from "../src/commutingTravelMinimisation";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const travelBefore = argument("--travel-before") ?? D5_TRAVEL_CUTOFF;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({ appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nD6 — clear commuting and travel identifiers (${organisationId}) — ${commit ? "COMMIT" : "dry run: the whole run, rolled back"}`);
  log(`  connection: ${tls.description}`);
  log(`  travel identifiers cleared on what was written before ${travelBefore}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-d6-clear-commuting-travel-identifiers" });
  try {
    const outcome = await clearCommutingTravelIdentifiers(pool, organisationId, { commit, travelBefore });
    const verb = commit ? "cleared" : "would clear";
    log(`  ${verb}: ${outcome.commutingSources} commuting source(s), ${outcome.commutingRows} commuting row(s); ${outcome.relabelled} source(s) relabelled "Commuter n"`);
    log(`  ${verb}: ${outcome.travelSources} travel source(s), ${outcome.travelRows} travel row(s)`);
    log(`  migrated history left as it is (0133 — for a ruling): ${outcome.migratedLeft} row(s) holding an identifier`);
    log(`  still held: ${outcome.remaining}${outcome.remaining === 0 ? "" : " — POST-CONDITION MISS: expected 0"}`);
    if (outcome.remaining !== 0) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => { process.stderr.write(`\nclear-commuting-travel-identifiers failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
