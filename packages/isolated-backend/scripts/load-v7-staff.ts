/**
 * Reconcile v7's staff into the roster (admin Phase B, B2; ruled `phaseB-team-access-plan.md` §3).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-staff --tables users --file C:/v7-extract-staff/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-staff/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-staff --tables users
 *   npm run load:v7-staff -- C:/v7-extract-staff [--organisation <id>] [--create <ref> ...] [--show-unmatched-names] [--commit]
 *
 * The extract holds v7's user id, name, address, status, role, type, archived flag and position — never a password,
 * an MFA secret, a rate or a phone number — and is deleted after the load.
 *
 * A dry run unless `--commit`, and a dry run is the load rolled back. **The report names nobody and gives no address**:
 * matched members by their console id, unmatched v7 users by a stable `ref` (a digest of the address digest). Q3: nobody
 * unmatched is created unless named with `--create <ref>` (repeatable). `--show-unmatched-names` writes the unmatched
 * people's names — to **stderr only**, for the operator to decide, never into the report. Sealing keys come from the
 * environment, as every sealed write does. Fail-closed on the boundary; verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7Staff, planV7Staff, V7_STAFF_TABLES } from "../src/v7StaffLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const all = (name: string) => process.argv.flatMap((value, index) => value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : []);

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-staff <extract directory> [--organisation <id>] [--create <ref> ...] [--show-unmatched-names] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");
  const create = all("--create");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const keys = resolveSealingKeys();
  const read = readV7Extract(directory, { tables: V7_STAFF_TABLES });
  log(`\nv7 staff into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7Staff(read.extract);
  log(`  v7: ${plan.v7.total} users · internal and loadable ${plan.staff.length} (${plan.v7.active} active, ${plan.v7.inactive} disabled or archived)`);
  for (const refusal of plan.refused) log(`  left out: ${refusal.count} × ${refusal.reason}`);
  if (create.length) log(`  to create (named with --create): ${create.join(", ")}`);
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-staff-load" });
  try {
    const outcome = await loadV7Staff(pool, organisationId, plan, { commit, keys, create });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    let problems = 0;
    log(`\n  matched to a membership (${outcome.matched.length}) — role, status, name and address never touched:`);
    for (const entry of outcome.matched) {
      log(`    ${entry.userId}: ${entry.changed.length ? `sets ${entry.changed.join(", ")}` : "unchanged"}${entry.notes.length ? ` · ${entry.notes.join(" · ")}` : ""}`);
      if (entry.conflict) { log(`      REFUSED (R4) ${entry.conflict}`); problems += 1; }
    }
    log(`\n  in v7 with no membership (${outcome.unmatched.length}) — created only when named (Q3):`);
    for (const entry of outcome.unmatched) {
      log(`    ref ${entry.ref}: v7 ${entry.v7Active ? "active" : "disabled or archived"} · position ${entry.positionLabel === null ? "none" : "given"} · ${entry.created ? `CREATED ${entry.created.userId} (${entry.created.status}, Viewer)` : "not created"}`);
    }
    log(`\n  positions: ${outcome.positions.filled} filled · ${outcome.positions.unmatchedLabels} v7 label(s) matching no active position · ${outcome.positions.ambiguousLabels} matching more than one`);
    for (const refusal of outcome.refused.filter((entry) => !plan.refused.includes(entry))) { log(`  REFUSED ${refusal.reason}`); problems += 1; }
    const p = outcome.parity;
    log(`  parity: v7 ${p.v7Active} active / ${p.v7Inactive} disabled · console (from v7) ${p.consoleActive} active / ${p.consoleDeactivated} deactivated · console not from v7 ${p.consoleNotFromV7}`);
    if (process.argv.includes("--show-unmatched-names") && outcome.namesForOperator.length) {
      process.stderr.write(`\nFor the operator only — not part of the report — the unmatched v7 users by ref:\n`);
      for (const entry of outcome.namesForOperator) process.stderr.write(`  ${entry.ref}  ${entry.name}\n`);
    }
    if (problems) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit (and any --create <ref>) to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-staff failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
