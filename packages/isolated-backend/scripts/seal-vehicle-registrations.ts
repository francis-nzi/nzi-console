/**
 * Data entry D4 (R1, 0196) — seal the company-vehicle registrations written before 0196, once, behind the staging gate.
 *
 *   npm run seal:vehicle-registrations -w @nzi/isolated-backend -- [--organisation <id>] [--commit]
 *
 * Every vehicle scope row and source still holding a plaintext plate is sealed under its client's vehicle key by the same
 * `sealVehicleIdentifiers` the writes use, and the plaintext cleared. Its queue is "plaintext present", so an interrupted run has
 * more to do and re-running continues. A dry run is the whole run, rolled back. Output is counts only — never a plate. Needs the
 * sealing keys (NZI_SUBJECT_MASTER_KEY, NZI_SUBJECT_INDEX_KEY, NZI_SUBJECT_LINKAGE_KEY); fails closed without them.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { sealExistingVehicleRegistrations } from "../src/vehicleRegistrations";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({ appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`\nD4 — seal company-vehicle registrations (${organisationId}) — ${commit ? "COMMIT" : "dry run: the whole run, rolled back"}`);
  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-d4-seal-vehicle-registrations" });
  try {
    const outcome = await sealExistingVehicleRegistrations(pool, organisationId, { commit });
    log(`  ${commit ? "sealed" : "would seal"}: ${outcome.rows} vehicle row(s), ${outcome.sources} vehicle source(s)`);
    log(`  left in the clear: ${outcome.optedOutLeft} name(s) on opted-out clients (by design) · ${outcome.remaining} registration(s)${outcome.remaining === 0 ? "" : " — POST-CONDITION MISS: expected 0"}`);
    if (outcome.remaining !== 0) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => { process.stderr.write(`\nseal-vehicle-registrations failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
