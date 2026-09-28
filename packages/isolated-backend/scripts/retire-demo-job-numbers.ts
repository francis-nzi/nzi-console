/**
 * Move the demo organisation's job numbers out of v7's range before the v7 load (decision 1a).
 *
 *   npm run retire:demo-job-numbers -- --organisation <demo organisation id> --above <v7's highest number> [--commit]
 *
 * `--above` is the highest v7 job number the load will bring (764 by §9; the v7 dry run prints it as "up to J000764").
 * Every job of the named organisation numbered at or below it moves to the next free number above, in order, with one
 * audit event each, and the counter is caught up. A dry run unless `--commit`: the same work, rolled back.
 *
 * Refuses net-zero-international outright, and any organisation holding imported jobs. Fail-closed on the boundary like
 * every other write here, and a non-local database is reached only over verified TLS — Supabase's CA as
 * sslrootcert=<path> or NZI_DATABASE_CA_CERT (src/databaseTls.ts).
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { retireDemoJobNumbers } from "../src/demoJobNumberRetirement";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const organisationId = argument("--organisation");
  const above = Number(argument("--above"));
  if (!organisationId) throw new Error("Usage: retire-demo-job-numbers --organisation <demo organisation id> --above <v7's highest number> [--commit]");
  const commit = process.argv.includes("--commit");
  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  // A non-local database is reached over verified TLS, or not at all (src/databaseTls.ts).
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 1, application_name: "nzi-retire-demo-job-numbers" });
  try {
    const outcome = await retireDemoJobNumbers(pool, { organisationId, above, commit });
    log(`\nRetire demo job numbers in ${organisationId} at or below J${String(above).padStart(6, "0")} — ${commit ? "COMMIT" : "dry run, rolled back"}`);
    const p = outcome.protectedCheck;
    log(`  ${p.organisationId}: ${p.jobs} job(s) and ${p.auditEvents} audit event(s) — checked before, inside and after the run: unchanged, 0 touched`);
    if (outcome.moved.length === 0) { log("  Nothing to move: no job of this organisation holds a number in v7's range."); return; }
    for (const move of outcome.moved) log(`  ${move.jobId}: ${move.from} → ${move.to}`);
    log(`  ${outcome.moved.length} job(s) ${commit ? "moved" : "would move"}; counter ${commit ? "now" : "would be"} at ${outcome.counterAt}`);
    if (outcome.frozenCopies.trainingEntitlements > 0) {
      log(`  ${outcome.frozenCopies.trainingEntitlements} training entitlement(s) keep the old number they were issued under, as written`);
    }
    log(`  audit correlation ${outcome.correlationId}`);
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nretire-demo-job-numbers failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
