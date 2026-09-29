/**
 * Backfill v7's job milestones into `job_milestones`, for jobs already imported (docs/LIST_PARITY_DESIGN.md, PR 2).
 *
 *   node packages/isolated-backend/scripts/v7-extract-sql.mjs --out C:/v7-extract --tables job_plan --file C:/v7-extract/extract.sql
 *   psql "<live v7 url>" -X -v ON_ERROR_STOP=1 -f C:/v7-extract/extract.sql
 *   node packages/isolated-backend/scripts/v7-extract-manifest.mjs C:/v7-extract --tables job_plan
 *   npm run load:v7-milestones -- C:/v7-extract [--organisation <id>] [--commit]
 *
 * A dry run unless `--commit`, and a dry run is the load, per client, rolled back. It reports what the ruling asks
 * to rule on before any commit:
 *
 * - `job_plan` rows read, matched to imported jobs, and not matched (a job added in v7 since the first extract);
 * - milestones by kind — dated, completed, completed with no due date — and labels dropped (A2);
 * - "completed by": how many are labelled, how many distinct, how many resolve to a membership (R4) — counts, never
 *   the values;
 * - Risk for every imported job, and for every client under **both** job sets (R1: all jobs, and excluding cancelled);
 * - every client where the console's label is not v7's own, per job set, with the job and milestone behind it —
 *   judged on the extract's London operating day, the same day substituted into v7's rule (A1);
 * - jobs refused under R3 (changed on both sides), by job number and kind.
 *
 * Only the extract's `job_plan` is read, and the manifest must verify it. Fail-closed on the boundary like every other
 * write here; a non-local database is reached only over verified TLS (src/databaseTls.ts).
 */
import { Pool } from "pg";
import { RISK_LEVELS, todayInLondon } from "@nzi/contracts";
import { validateDatabaseBoundary } from "../src/databaseBoundary";
import { verifiedTlsConfig } from "../src/databaseTls";
import { CLIENT_RISK_JOBS } from "../src/milestoneRisk";
import { withTenantRead } from "../src/postgres";
import { readV7Extract } from "../src/v7ClientExtract";
import { DEFAULT_ORGANISATION } from "../src/v7ClientImport";
import { loadV7Milestones, MILESTONE_KINDS, milestoneRiskReport, planV7Milestones, readConsoleClients, readConsoleJobs } from "../src/v7MilestoneLoad";

const log = (line = "") => process.stdout.write(`${line}\n`);
const argument = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const levels = (counts: Record<string, number>) => RISK_LEVELS.map((level) => `${level} ${counts[level]}`).join(" · ");

async function main(): Promise<void> {
  const directory = process.argv[2];
  if (!directory || directory.startsWith("--")) throw new Error("Usage: load-v7-milestones <extract directory> [--organisation <id>] [--commit]");
  const organisationId = argument("--organisation") ?? DEFAULT_ORGANISATION;
  const commit = process.argv.includes("--commit");

  const url = validateDatabaseBoundary({
    appEnv: process.env.NEXT_PUBLIC_APP_ENV,
    boundaryToken: process.env.NZI_DATABASE_BOUNDARY,
    isolatedDatabaseUrl: process.env.NZI_ISOLATED_DATABASE_URL,
  });
  const tls = verifiedTlsConfig(url, { caCert: process.env.NZI_DATABASE_CA_CERT });
  const read = readV7Extract(directory, { tables: ["job_plan"] });
  log(`\nv7 milestone backfill into ${organisationId} — ${commit ? "COMMIT" : "dry run: each client loaded and rolled back"}`);
  log(`  extract sha256 ${read.extractSha256}`);
  if (read.problems.length > 0) {
    log("\nREFUSED — the extract does not match its manifest:");
    for (const problem of read.problems) log(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  const operatingDays = new Set((read.parity ?? []).map((row) => row.operating_day).filter(Boolean));
  if (operatingDays.size > 1) throw new Error("the parity file carries more than one operating day — it was not taken in one snapshot");
  const operatingDay = [...operatingDays][0] ?? todayInLondon();
  const plan = planV7Milestones(read.extract.job_plan);

  log(`  job_plan rows ${read.extract.job_plan.length} · readable ${plan.jobs.length} · unreadable ${plan.unreadable.length}`);
  for (const entry of plan.unreadable) log(`      v7 job ${entry.v7JobId}: ${entry.reason}`);
  for (const kind of MILESTONE_KINDS) {
    const count = plan.byKind[kind];
    log(`  ${kind.padEnd(16)} dated ${count.dated} · completed ${count.completed} · completed with no due date ${count.undatedCompleted}`);
  }
  log(`  "completed by" with no completion — label dropped, due date kept (A2): ${plan.labelsDropped}`);
  log(`  operating day ${operatingDay} (${read.parity ? "the extract's, London" : "today, London — no parity file"})`);

  log(`  connection: ${tls.description}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 2, application_name: "nzi-v7-milestone-load" });
  try {
    const { clients, jobs } = await withTenantRead(pool, organisationId, async (db) => ({ clients: await readConsoleClients(db), jobs: await readConsoleJobs(db) }));
    const outcome = await loadV7Milestones(pool, organisationId, plan, { commit });
    log(`\n${commit ? "Written" : "Would write"} (run ${outcome.runId}):`);
    log(`  milestones +${outcome.inserted} inserted · ${outcome.updated} updated from v7 (R3) · =${outcome.unchanged} already loaded and identical`);
    log(`  job_plan rows matched to an imported job ${plan.jobs.length - outcome.unmatchedV7JobIds.length} · not matched ${outcome.unmatchedV7JobIds.length}`);
    if (outcome.unmatchedV7JobIds.length) log(`      v7 job ids: ${outcome.unmatchedV7JobIds.slice(0, 40).join(", ")}${outcome.unmatchedV7JobIds.length > 40 ? " …" : ""}`);
    const { labelled, distinct, matched } = outcome.completedBy;
    log(`  "completed by" (R4): ${labelled} labelled · ${distinct} distinct · ${matched} resolved to a membership (${labelled ? Math.round((100 * matched) / labelled) : 0}%)`);

    const report = milestoneRiskReport(plan, clients, jobs, read.parity, operatingDay);
    log(`\nRisk on ${report.operatingDay}`);
    log(`  jobs (${jobs.length})                     ${levels(report.jobs)}`);
    log(`  clients (${clients.length}), (a) all jobs          ${levels(report.clients.all)}`);
    log(`  clients (${clients.length}), (b) excluding cancelled ${levels(report.clients["exclude-cancelled"])}`);
    log(`  the rule as built rolls up over: ${CLIENT_RISK_JOBS} (R1, provisional — confirmed on these numbers)`);
    if (read.parity) {
      log(`\nParity with v7's own client Risk (${read.parity.length} clients; ${report.parityUnmatched} not imported)`);
      for (const jobSet of ["all", "exclude-cancelled"] as const) {
        const differences = report.differences[jobSet];
        log(`  (${jobSet === "all" ? "a" : "b"}) ${jobSet}: ${differences.length} client(s) differ from v7`);
        for (const difference of differences) {
          log(`    ${difference.clientId}: console ${difference.console}, v7 ${difference.v7}`);
          for (const reason of difference.reasons) log(`        ${reason}`);
        }
      }
    }
    if (outcome.conflicts.length > 0) {
      log(`\n${new Set(outcome.conflicts.map((c) => c.jobNumber)).size} job(s) REFUSED under R3 — nothing of each was written:`);
      for (const conflict of outcome.conflicts) log(`  ${conflict.jobNumber} ${conflict.kind}: ${conflict.reason}`);
      process.exitCode = 1;
    }
    if (outcome.failedClients.length > 0) {
      log(`\n${outcome.failedClients.length} client(s) FAILED — nothing of each was written:`);
      for (const failure of outcome.failedClients) log(`  ${failure.clientId}: ${failure.reason}`);
      process.exitCode = 1;
    }
    if (!commit) log("\nDry run complete. Re-run with --commit to write.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`\nload-v7-milestones failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
