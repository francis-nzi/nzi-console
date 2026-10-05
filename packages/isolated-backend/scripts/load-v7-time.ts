/**
 * Import v7's time (⚑7; kickoff `V7-time-import-loader-kickoff.md`): v7's `time_subjects` into `activity_types`, then
 * its `time_logs` into `time_entries` — one transaction.
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract-time --tables time_subjects,time_logs --file C:/v7-extract-time/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract-time/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract-time --tables time_subjects,time_logs
 *   npm run load:v7-time -- C:/v7-extract-time [--organisation <id>] [--show-unmatched-addresses] [--commit]
 *
 * The extract holds each entry's job id, v7 user id (an address), subject, day, minutes and note — the time logged on
 * the imported jobs only — and is deleted after the load.
 *
 * A dry run unless `--commit`, and a dry run is the load, rolled back. **The report is counts, classes and refs**: no
 * person, no address, no rate. Unmatched people appear by a stable `ref` (a digest of the address digest);
 * `--show-unmatched-addresses` writes the addresses behind them to **stderr only**, for the operator to resolve.
 * Sealing keys come from the environment (the person match is the address's blind index). Fail-closed on the boundary;
 * verified TLS off-machine.
 */
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { FAR_PAST, loadV7Time, planV7Time, TIME_REFUSALS, V7_TIME_TABLES, type TimeRefusal } from "../src/v7TimeLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const hours = (minutes: number) => `${Math.round((minutes / 60) * 100) / 100} h`;

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-time <extract directory> [--organisation <id>] [--show-unmatched-addresses] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV, boundaryToken: process.env.NZI_DATABASE_BOUNDARY, isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const keys = resolveSealingKeys();
  const read = readV7Extract(directory, { tables: V7_TIME_TABLES });
  log(`\nv7 time into ${organisationId} — ${commit ? "COMMIT" : "dry run: the whole load, rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const plan = planV7Time(read.extract);
  log(`  v7: ${plan.v7.entries} entries (${hours(plan.v7.minutes)}) · ${plan.entries.length} loadable · subjects ${plan.subjects.categories[0]?.values.length ?? 0}`);
  for (const [reason, count] of Object.entries(plan.refused)) log(`  left out: ${count} × ${TIME_REFUSALS[reason as TimeRefusal]}`);
  for (const skipped of plan.subjects.skipped) log(`  subject left out: v7 ${skipped.legacyDbId} — ${skipped.reason}`);
  log(`  connection: ${tls.description}`);

  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-time-load" });
  try {
    const outcome = await loadV7Time(pool, organisationId, plan, { commit, keys });
    const s = outcome.subjects;
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    log(`\n  step 1 — subjects into activity types: ${s.inserted} added · ${s.stamped} matched to an existing activity by label · ${s.updated} updated · ${s.unchanged} unchanged`
      + `${s.conflicts.length ? ` · ${s.conflicts.length} REFUSED (edited here since)` : ""}`);
    log(`    billable defaults: ${s.defaultsCreated} created (billable) · ${s.defaultsKept.length} kept as set here${s.defaultsKept.length ? ` (${s.defaultsKept.map((d) => `${d.label}: ${d.billableDefault ? "billable" : "non-billable"}`).join(", ")})` : ""}`);
    log(`\n  step 2 — entries: ${outcome.inserted} ${commit ? "written" : "to write"} · ${outcome.alreadyImported} already imported${outcome.changedInV7 ? ` (${outcome.changedInV7} changed in v7 since — not re-applied)` : ""}`);
    log(`    rates: ${outcome.rates.recorded} with a rate in force on the day · ${outcome.rates.notRecorded} "rate not recorded" (null — never today's rate, never 0)`);
    if (outcome.farPast) log(`    ${outcome.farPast} with a work date before ${FAR_PAST} — imported, reported for a look`);
    log(`    not imported — no person matched: ${outcome.unmatchedUsers.reduce((sum, u) => sum + u.entries, 0)} entries across ${outcome.unmatchedUsers.length} v7 user(s)`);
    for (const user of outcome.unmatchedUsers) log(`      ref ${user.ref}: ${user.entries}`);
    if (outcome.ambiguousUsers.length) log(`    not imported — an address matching more than one member: ${outcome.ambiguousUsers.map((u) => `ref ${u.ref} (${u.entries})`).join(", ")}`);
    log(`    not imported — job not imported: ${outcome.jobNotImported}`);
    log(`    not imported — no subject: ${outcome.noSubject}`);
    log(`    not imported — subject matching no activity (for a ruling: add it as a value, or leave these out): ${outcome.unmatchedSubjects.reduce((sum, u) => sum + u.entries, 0)}`);
    for (const subject of outcome.unmatchedSubjects) log(`      "${subject.label}": ${subject.entries}`);
    const p = outcome.parity;
    log(`  parity: v7 minutes on the mapped entries ${hours(p.plannedMinutes)} · console (from v7) ${hours(p.consoleMinutes)} across ${p.consoleEntries} entries`);
    if (process.argv.includes("--show-unmatched-addresses") && outcome.addressesForOperator.length) {
      process.stderr.write("\nFor the operator only — not part of the report — the addresses behind the unmatched refs:\n");
      for (const entry of outcome.addressesForOperator) process.stderr.write(`  ${entry.ref}  ${entry.email}\n`);
    }
    if (s.conflicts.length) process.exitCode = 1;
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-time failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
