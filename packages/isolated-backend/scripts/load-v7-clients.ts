/**
 * Load v7's active clients and their job history (docs/CLIENT_JOB_IMPORT_DESIGN.md §8).
 *
 *   npm run load:v7-clients -- <extract directory> [--organisation <id>] [--commit]
 *
 * The extract directory holds one CSV per table and a `manifest.json` (Appendix B). A dry run unless `--commit` — and
 * a dry run is the whole load, per client, rolled back: every constraint, trigger, seal and job-number clash is
 * exercised and nothing is kept. Every refusal, exclusion and report is printed; every excluded record (a closed list
 * of named reasons) is written to `<extract>/exclusions.csv`, dry run or not.
 *
 * With `--commit`, and only when the plan carries no refusal, each client loads in its own transaction: a client that
 * fails leaves nothing behind and the others go ahead. Re-running is safe — a record already loaded and identical is
 * left alone; one that differs refuses its client.
 *
 * Fail-closed on the boundary like every other write here: production APP_ENV is refused and NZI_DATABASE_BOUNDARY must
 * say isolated-non-production. Sealing keys come from the environment (NZC-119). A non-local database is reached only
 * over verified TLS — Supabase's CA as sslrootcert=<path> or NZI_DATABASE_CA_CERT (src/databaseTls.ts).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION, planV7ClientImport, type Finding } from "../src/v7ClientImport";
import { loadV7ClientPlan } from "../src/v7ClientLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const printFindings = (title: string, findings: Finding[]) => {
  if (findings.length === 0) return;
  log(`\n${title}`);
  for (const finding of findings) {
    log(`  ${finding.code} ×${finding.count} — ${finding.message}`);
    for (const example of finding.examples) log(`      ${example}`);
  }
};

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-clients <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  // Before the extract is even read: a non-local database is reached over verified TLS, or not at all.
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory);
  const plan = planV7ClientImport({
    extract: read.extract, headers: read.headers, extractSha256: read.extractSha256, organisationId, extractProblems: read.problems,
  });
  const s = plan.summary;
  log(`\nv7 client-and-job load into ${organisationId} — ${commit ? "COMMIT" : "dry run: each client loaded and rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  log(`  clients ${s.clients} (${s.portfolioOwners} Portfolio Owner, ${s.portfolioOwnersLinked} linked to a portfolio) · sites ${s.sites} · contacts ${s.contacts} · jobs ${s.jobs} (up to J${String(s.maxSequence).padStart(6, "0")})`);
  log(`  migrated rows ${s.rows} (${s.rowsEnabled} enabled, ${s.registerRows} from registers) · report versions ${s.reports} · LCA results ${s.lcaResults}`);
  log(`  published jobs ${s.jobsPublished}: ${s.jobsReconciled} reconcile exactly, ${s.jobsWithDifferences} differ (reported, never corrected)`);
  printFindings("REFUSALS — the load will not run until each is resolved", plan.refusals);
  printFindings(`Excluded — ${plan.excluded.length} records skipped for a named reason, not blocking`, plan.exclusions);
  printFindings("Reports — shown, not blocking", plan.reports);

  const exclusionReport = join(directory, "exclusions.csv");
  writeFileSync(exclusionReport, [["table", "legacy_id", "reason"], ...plan.excluded.map((entry) => [entry.table, entry.legacyId, entry.reason])]
    .map((cells) => cells.map((cell) => `"${cell.replace(/"/g, "\"\"")}"`).join(",")).join("\n") + "\n");
  log(`\nExclusion report (every excluded record): ${exclusionReport}`);
  if (plan.refusals.length > 0) { process.exitCode = 1; return; }

  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-client-load" });
  try {
    const outcome = await loadV7ClientPlan(pool, plan, { commit });
    const refused = outcome.clients.filter((client) => client.state === "refused");
    const total = (state: "inserted" | "unchanged", kind: keyof (typeof outcome.clients)[number]["inserted"]) =>
      outcome.clients.reduce((sum, client) => sum + client[state][kind], 0);
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    for (const kind of ["clients", "sites", "contacts", "targets", "jobs", "rows", "reports"] as const) {
      log(`  ${kind.padEnd(8)} +${total("inserted", kind)} (=${total("unchanged", kind)} already loaded and identical)`);
    }
    if (outcome.counterAt !== null) log(`  job-number counter now at ${outcome.counterAt}`);
    if (refused.length > 0) {
      log(`\n${refused.length} client(s) REFUSED — nothing of each was written:`);
      for (const client of refused) log(`  ${client.clientId}: ${client.refusal}`);
      process.exitCode = 1;
    }
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-clients failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
